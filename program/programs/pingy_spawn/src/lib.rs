use anchor_lang::prelude::*;
use anchor_lang::system_program;

declare_id!("FSvYheeHSLjU6UKqka5AnMeaPwsQBrLm8dCL4VtFpf5R");

pub const SPAWN_FEE_BPS: u64 = 100;
pub const BPS_DENOM: u64 = 10_000;
pub const LAMPORTS_PER_SOL: u64 = 1_000_000_000;

pub const MIN_APPROVED_WALLETS_MIN: u32 = 10;
pub const MIN_APPROVED_WALLETS_MAX: u32 = 50;
pub const SPAWN_TARGET_MIN_LAMPORTS: u64 = LAMPORTS_PER_SOL;
pub const SPAWN_TARGET_MAX_LAMPORTS: u64 = 100 * LAMPORTS_PER_SOL;
pub const MAX_WALLET_SHARE_BPS_MIN: u16 = 200;
pub const MAX_WALLET_SHARE_BPS_MAX: u16 = 2000;

#[program]
pub mod pingy_spawn {
    use super::*;

    pub fn initialize_thread(
        ctx: Context<InitializeThread>,
        thread_id: String,
        min_approved_wallets: u32,
        spawn_target_lamports: u64,
        max_wallet_share_bps: u16,
    ) -> Result<()> {
        require!(!thread_id.is_empty(), PingyError::InvalidThreadId);
        require!(
            (MIN_APPROVED_WALLETS_MIN..=MIN_APPROVED_WALLETS_MAX).contains(&min_approved_wallets),
            PingyError::MinApprovedWalletsOutOfBounds
        );
        require!(
            (SPAWN_TARGET_MIN_LAMPORTS..=SPAWN_TARGET_MAX_LAMPORTS)
                .contains(&spawn_target_lamports),
            PingyError::SpawnTargetOutOfBounds
        );
        require!(
            (MAX_WALLET_SHARE_BPS_MIN..=MAX_WALLET_SHARE_BPS_MAX).contains(&max_wallet_share_bps),
            PingyError::MaxWalletShareOutOfBounds
        );

        let thread = &mut ctx.accounts.thread;
        thread.thread_id = thread_id.clone();
        thread.admin_pubkey = ctx.accounts.admin.key();
        thread.spawn_state = SpawnState::Open;
        thread.pending_count = 0;
        thread.approved_count = 0;
        thread.total_allocated_lamports = 0;
        thread.total_escrow_lamports = 0;
        thread.min_approved_wallets = min_approved_wallets;
        thread.spawn_target_lamports = spawn_target_lamports;
        thread.max_wallet_share_bps = max_wallet_share_bps;

        let spawn_pool = &mut ctx.accounts.spawn_pool;
        spawn_pool.thread_id = thread_id.clone();

        let thread_escrow = &mut ctx.accounts.thread_escrow;
        thread_escrow.thread_id = thread_id;

        let fee_vault = &mut ctx.accounts.fee_vault;
        if !fee_vault.initialized {
            fee_vault.initialized = true;
        }

        Ok(())
    }

    pub fn ping_deposit(
        ctx: Context<PingDeposit>,
        thread_id: String,
        amount_lamports: u64,
    ) -> Result<()> {
        require!(amount_lamports > 0, PingyError::InvalidAmount);

        let thread = &mut ctx.accounts.thread;
        require!(thread.thread_id == thread_id, PingyError::ThreadMismatch);
        require!(
            thread.spawn_state == SpawnState::Open,
            PingyError::SpawnAlreadyClosed
        );

        let mut is_new_deposit = false;
        {
            let deposit = &mut ctx.accounts.deposit;
            if deposit.thread_id.is_empty() {
                is_new_deposit = true;
                deposit.thread_id = thread_id.clone();
                deposit.user_pubkey = ctx.accounts.user.key();
                deposit.status = DepositStatus::Pending;
                deposit.rejected_once = false;
                deposit.refundable_lamports = 0;
                deposit.allocated_lamports = 0;
            }
            require!(
                deposit.user_pubkey == ctx.accounts.user.key(),
                PingyError::UserMismatch
            );
        }

        let transfer_ctx = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.user.to_account_info(),
                to: ctx.accounts.thread_escrow.to_account_info(),
            },
        );
        system_program::transfer(transfer_ctx, amount_lamports)?;
        msg!(
            "ping_deposit amount={} user={} escrow={} thread={}",
            amount_lamports,
            ctx.accounts.user.key(),
            ctx.accounts.thread_escrow.key(),
            thread_id
        );
        thread.total_escrow_lamports = thread
            .total_escrow_lamports
            .checked_add(amount_lamports)
            .ok_or(PingyError::AmountOverflow)?;

        let previous_status;
        {
            let deposit = &mut ctx.accounts.deposit;
            previous_status = deposit.status;

            if ctx.accounts.user.key() == thread.admin_pubkey {
                deposit.status = DepositStatus::Approved;
            } else if deposit.status != DepositStatus::Approved {
                deposit.status = DepositStatus::Pending;
            }

            deposit.refundable_lamports = deposit
                .refundable_lamports
                .checked_add(amount_lamports)
                .ok_or(PingyError::AmountOverflow)?;

            if deposit.status == DepositStatus::Approved {
                allocate_for_deposit(thread, deposit)?;
            }
        }

        if is_new_deposit {
            thread.increment_status_count(ctx.accounts.deposit.status)?;
        } else {
            thread.apply_status_transition(previous_status, ctx.accounts.deposit.status)?;
        }

        Ok(())
    }

    pub fn approve_user(
        ctx: Context<ApproveUser>,
        thread_id: String,
        user_pubkey: Pubkey,
    ) -> Result<()> {
        let thread = &ctx.accounts.thread;
        require!(thread.thread_id == thread_id, PingyError::ThreadMismatch);

        let deposit = &mut ctx.accounts.deposit;
        require!(deposit.user_pubkey == user_pubkey, PingyError::UserMismatch);

        let previous_status = deposit.status;
        deposit.status = DepositStatus::Approved;
        let thread = &mut ctx.accounts.thread;
        allocate_for_deposit(thread, deposit)?;
        thread.apply_status_transition(previous_status, deposit.status)?;

        Ok(())
    }

    pub fn revoke_approved_user(
        ctx: Context<RevokeApprovedUser>,
        thread_id: String,
        user_pubkey: Pubkey,
    ) -> Result<()> {
        require!(
            ctx.accounts.thread.thread_id == thread_id,
            PingyError::ThreadMismatch
        );
        require!(
            ctx.accounts.thread.spawn_state == SpawnState::Open,
            PingyError::SpawnAlreadyClosed
        );

        let deposit = &mut ctx.accounts.deposit;
        require!(deposit.user_pubkey == user_pubkey, PingyError::UserMismatch);
        require!(
            deposit.status == DepositStatus::Approved,
            PingyError::DepositNotApproved
        );

        let allocated_before = deposit.allocated_lamports;
        let previous_status = deposit.status;
        deposit.status = DepositStatus::Revoked;

        let thread = &mut ctx.accounts.thread;
        thread.total_allocated_lamports = thread
            .total_allocated_lamports
            .checked_sub(allocated_before)
            .ok_or(PingyError::AccountingUnderflow)?;
        thread.apply_status_transition(previous_status, deposit.status)?;

        Ok(())
    }

    pub fn unping_withdraw(ctx: Context<UserWithdraw>, thread_id: String) -> Result<()> {
        let thread = &ctx.accounts.thread;
        require!(thread.thread_id == thread_id, PingyError::ThreadMismatch);
        require!(
            thread.spawn_state == SpawnState::Open,
            PingyError::SpawnAlreadyClosed
        );

        let user_key = ctx.accounts.user.key();
        let deposit = &mut ctx.accounts.deposit;
        require!(deposit.user_pubkey == user_key, PingyError::UserMismatch);

        let payout = deposit
            .refundable_lamports
            .checked_add(deposit.allocated_lamports)
            .ok_or(PingyError::AmountOverflow)?;
        let allocated_before = deposit.allocated_lamports;
        let previous_status = deposit.status;

        msg!(
            "unping_withdraw payout={} refundable={} allocated={}",
            payout,
            deposit.refundable_lamports,
            deposit.allocated_lamports
        );
        transfer_from_thread_escrow_to_account(
            &ctx.accounts.thread_escrow.to_account_info(),
            &ctx.accounts.user.to_account_info(),
            payout,
        )?;

        let thread = &mut ctx.accounts.thread;
        thread.total_allocated_lamports = thread
            .total_allocated_lamports
            .checked_sub(allocated_before)
            .ok_or(PingyError::AccountingUnderflow)?;
        thread.total_escrow_lamports = thread
            .total_escrow_lamports
            .checked_sub(payout)
            .ok_or(PingyError::AccountingUnderflow)?;

        deposit.refundable_lamports = 0;
        deposit.allocated_lamports = 0;
        deposit.status = DepositStatus::Withdrawn;
        thread.apply_status_transition(previous_status, deposit.status)?;

        Ok(())
    }

    pub fn execute_spawn(ctx: Context<ExecuteSpawn>, thread_id: String) -> Result<()> {
        let thread = &mut ctx.accounts.thread;
        require!(thread.thread_id == thread_id, PingyError::ThreadMismatch);
        require!(
            thread.spawn_state == SpawnState::Open,
            PingyError::SpawnAlreadyClosed
        );
        require!(
            thread.total_allocated_lamports >= thread.spawn_target_lamports,
            PingyError::SpawnTargetNotReached
        );
        require!(
            thread.approved_count >= thread.min_approved_wallets,
            PingyError::MinApprovedWalletsNotReached
        );

        let use_amt = thread.spawn_target_lamports;
        let fee = use_amt
            .checked_mul(SPAWN_FEE_BPS)
            .ok_or(PingyError::AmountOverflow)?
            .checked_div(BPS_DENOM)
            .ok_or(PingyError::AmountOverflow)?;
        let net = use_amt
            .checked_sub(fee)
            .ok_or(PingyError::AccountingUnderflow)?;

        transfer_from_thread_escrow_to_account(
            &ctx.accounts.thread_escrow.to_account_info(),
            &ctx.accounts.fee_vault.to_account_info(),
            fee,
        )?;
        transfer_from_thread_escrow_to_account(
            &ctx.accounts.thread_escrow.to_account_info(),
            &ctx.accounts.spawn_pool.to_account_info(),
            net,
        )?;

        thread.total_allocated_lamports = thread
            .total_allocated_lamports
            .checked_sub(use_amt)
            .ok_or(PingyError::AccountingUnderflow)?;
        thread.total_escrow_lamports = thread
            .total_escrow_lamports
            .checked_sub(use_amt)
            .ok_or(PingyError::AccountingUnderflow)?;
        thread.spawn_state = SpawnState::Closed;

        emit!(SpawnExecuted {
            thread_id,
            total_to_use: use_amt,
            fee,
            net,
        });

        Ok(())
    }
}

fn allocate_for_deposit(
    thread: &mut Account<Thread>,
    deposit: &mut Account<Deposit>,
) -> Result<()> {
    let remaining_needed = thread
        .spawn_target_lamports
        .saturating_sub(thread.total_allocated_lamports);
    let wallet_cap = thread
        .spawn_target_lamports
        .checked_mul(thread.max_wallet_share_bps as u64)
        .ok_or(PingyError::AmountOverflow)?
        .checked_div(BPS_DENOM)
        .ok_or(PingyError::AmountOverflow)?;
    let wallet_remaining = wallet_cap.saturating_sub(deposit.allocated_lamports);

    let movable = deposit
        .refundable_lamports
        .min(remaining_needed)
        .min(wallet_remaining);

    if movable == 0 {
        return Ok(());
    }

    deposit.refundable_lamports = deposit
        .refundable_lamports
        .checked_sub(movable)
        .ok_or(PingyError::AccountingUnderflow)?;
    deposit.allocated_lamports = deposit
        .allocated_lamports
        .checked_add(movable)
        .ok_or(PingyError::AmountOverflow)?;
    thread.total_allocated_lamports = thread
        .total_allocated_lamports
        .checked_add(movable)
        .ok_or(PingyError::AmountOverflow)?;

    Ok(())
}

fn transfer_from_thread_escrow_to_account<'info>(
    thread_escrow_info: &AccountInfo<'info>,
    recipient_account: &AccountInfo<'info>,
    amount: u64,
) -> Result<()> {
    require!(amount > 0, PingyError::NothingToRefund);

    let min_balance = Rent::get()?.minimum_balance(8 + ThreadEscrow::LEN);
    let available = thread_escrow_info.lamports().saturating_sub(min_balance);
    msg!(
        "escrow_refund_check amount={} escrow_lamports={} min_balance={} available={}",
        amount,
        thread_escrow_info.lamports(),
        min_balance,
        available
    );
    require!(available >= amount, PingyError::InsufficientEscrowBalance);

    **thread_escrow_info.try_borrow_mut_lamports()? = thread_escrow_info
        .lamports()
        .checked_sub(amount)
        .ok_or(PingyError::AccountingUnderflow)?;
    **recipient_account.try_borrow_mut_lamports()? = recipient_account
        .lamports()
        .checked_add(amount)
        .ok_or(PingyError::AmountOverflow)?;

    Ok(())
}

#[derive(Accounts)]
#[instruction(thread_id: String)]
pub struct InitializeThread<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        init,
        payer = admin,
        space = 8 + Thread::LEN,
        seeds = [b"thread", thread_id.as_bytes()],
        bump
    )]
    pub thread: Account<'info, Thread>,
    #[account(
        init,
        payer = admin,
        space = 8 + SpawnPool::LEN,
        seeds = [b"spawn_pool", thread_id.as_bytes()],
        bump
    )]
    pub spawn_pool: Account<'info, SpawnPool>,
    #[account(
        init,
        payer = admin,
        space = 8 + ThreadEscrow::LEN,
        seeds = [b"escrow", thread_id.as_bytes()],
        bump
    )]
    pub thread_escrow: Account<'info, ThreadEscrow>,
    #[account(
        init_if_needed,
        payer = admin,
        space = 8 + FeeVault::SIZE,
        seeds = [b"fee_vault"],
        bump
    )]
    pub fee_vault: Account<'info, FeeVault>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(thread_id: String)]
pub struct PingDeposit<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        mut,
        seeds = [b"thread", thread_id.as_bytes()],
        bump
    )]
    pub thread: Account<'info, Thread>,
    #[account(
        init_if_needed,
        payer = user,
        space = 8 + Deposit::SIZE,
        seeds = [b"deposit", thread_id.as_bytes(), user.key().as_ref()],
        bump
    )]
    pub deposit: Account<'info, Deposit>,
    #[account(
        mut,
        seeds = [b"escrow", thread_id.as_bytes()],
        bump,
        constraint = thread_escrow.thread_id == thread_id @ PingyError::ThreadMismatch
    )]
    pub thread_escrow: Account<'info, ThreadEscrow>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(thread_id: String, user_pubkey: Pubkey)]
pub struct ApproveUser<'info> {
    #[account(mut, address = thread.admin_pubkey)]
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [b"thread", thread_id.as_bytes()],
        bump
    )]
    pub thread: Account<'info, Thread>,
    #[account(
        mut,
        seeds = [b"deposit", thread_id.as_bytes(), user_pubkey.as_ref()],
        bump
    )]
    pub deposit: Account<'info, Deposit>,
}

#[derive(Accounts)]
#[instruction(thread_id: String, user_pubkey: Pubkey)]
pub struct RevokeApprovedUser<'info> {
    #[account(mut, address = thread.admin_pubkey)]
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [b"thread", thread_id.as_bytes()],
        bump
    )]
    pub thread: Account<'info, Thread>,
    #[account(
        mut,
        seeds = [b"deposit", thread_id.as_bytes(), user_pubkey.as_ref()],
        bump
    )]
    pub deposit: Account<'info, Deposit>,
}

#[derive(Accounts)]
#[instruction(thread_id: String)]
pub struct UserWithdraw<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        mut,
        seeds = [b"thread", thread_id.as_bytes()],
        bump
    )]
    pub thread: Account<'info, Thread>,
    #[account(
        mut,
        seeds = [b"deposit", thread_id.as_bytes(), user.key().as_ref()],
        bump,
        close = user
    )]
    pub deposit: Account<'info, Deposit>,
    #[account(
        mut,
        seeds = [b"escrow", thread_id.as_bytes()],
        bump,
        constraint = thread_escrow.thread_id == thread_id @ PingyError::ThreadMismatch
    )]
    pub thread_escrow: Account<'info, ThreadEscrow>,
}

#[derive(Accounts)]
#[instruction(thread_id: String)]
pub struct ExecuteSpawn<'info> {
    #[account(mut, address = thread.admin_pubkey)]
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [b"thread", thread_id.as_bytes()],
        bump
    )]
    pub thread: Account<'info, Thread>,
    #[account(
        mut,
        seeds = [b"escrow", thread_id.as_bytes()],
        bump,
        constraint = thread_escrow.thread_id == thread_id @ PingyError::ThreadMismatch
    )]
    pub thread_escrow: Account<'info, ThreadEscrow>,
    #[account(
        mut,
        seeds = [b"spawn_pool", thread_id.as_bytes()],
        bump
    )]
    pub spawn_pool: Account<'info, SpawnPool>,
    #[account(
        mut,
        seeds = [b"fee_vault"],
        bump
    )]
    pub fee_vault: Account<'info, FeeVault>,
    pub system_program: Program<'info, System>,
}

#[account]
pub struct Thread {
    pub thread_id: String,
    pub admin_pubkey: Pubkey,
    pub spawn_state: SpawnState,
    pub pending_count: u32,
    pub approved_count: u32,
    pub total_allocated_lamports: u64,
    pub total_escrow_lamports: u64,
    pub min_approved_wallets: u32,
    pub spawn_target_lamports: u64,
    pub max_wallet_share_bps: u16,
}

impl Thread {
    pub const MAX_THREAD_ID_LEN: usize = 64;
    pub const LEN: usize = 4 + Self::MAX_THREAD_ID_LEN + 32 + 1 + 4 + 4 + 8 + 8 + 4 + 8 + 2;

    fn increment_status_count(&mut self, new_status: DepositStatus) -> Result<()> {
        match new_status {
            DepositStatus::Pending => {
                self.pending_count = self
                    .pending_count
                    .checked_add(1)
                    .ok_or(PingyError::AmountOverflow)?;
            }
            DepositStatus::Approved => {
                self.approved_count = self
                    .approved_count
                    .checked_add(1)
                    .ok_or(PingyError::AmountOverflow)?;
            }
            _ => {}
        }
        Ok(())
    }

    fn decrement_status_count(&mut self, old_status: DepositStatus) -> Result<()> {
        match old_status {
            DepositStatus::Pending => {
                self.pending_count = self
                    .pending_count
                    .checked_sub(1)
                    .ok_or(PingyError::AccountingUnderflow)?;
            }
            DepositStatus::Approved => {
                self.approved_count = self
                    .approved_count
                    .checked_sub(1)
                    .ok_or(PingyError::AccountingUnderflow)?;
            }
            _ => {}
        }
        Ok(())
    }

    fn apply_status_transition(&mut self, old: DepositStatus, new: DepositStatus) -> Result<()> {
        if old == new {
            return Ok(());
        }
        self.decrement_status_count(old)?;
        self.increment_status_count(new)?;
        Ok(())
    }
}

#[account]
pub struct ThreadEscrow {
    pub thread_id: String,
}

#[account]
pub struct Deposit {
    pub thread_id: String,
    pub user_pubkey: Pubkey,
    pub status: DepositStatus,
    pub rejected_once: bool,
    pub refundable_lamports: u64,
    pub allocated_lamports: u64,
}

impl Deposit {
    pub const MAX_THREAD_ID_LEN: usize = 64;
    pub const SIZE: usize = 4 + Self::MAX_THREAD_ID_LEN + 32 + 1 + 1 + 8 + 8;
    pub const LEN: usize = Self::SIZE;
}

#[account]
pub struct SpawnPool {
    pub thread_id: String,
}

#[account]
pub struct FeeVault {
    pub initialized: bool,
}


impl ThreadEscrow {
    pub const MAX_THREAD_ID_LEN: usize = 64;
    pub const LEN: usize = 4 + Self::MAX_THREAD_ID_LEN;
}

impl FeeVault {
    pub const SIZE: usize = 1;
}


#[event]
pub struct SpawnExecuted {
    pub thread_id: String,
    pub total_to_use: u64,
    pub fee: u64,
    pub net: u64,
}

impl SpawnPool {
    pub const MAX_THREAD_ID_LEN: usize = 64;
    pub const LEN: usize = 4 + Self::MAX_THREAD_ID_LEN;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum SpawnState {
    Open,
    Closed,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum DepositStatus {
    Pending,
    Approved,
    Revoked,
    Rejected,
    Withdrawn,
    Converted,
}

#[error_code]
pub enum PingyError {
    #[msg("Invalid thread id")]
    InvalidThreadId,
    #[msg("Invalid amount")]
    InvalidAmount,
    #[msg("Thread id mismatch")]
    ThreadMismatch,
    #[msg("User mismatch")]
    UserMismatch,
    #[msg("Amount overflow")]
    AmountOverflow,
    #[msg("Deposit has been rejected permanently")]
    DepositRejectedPermanently,
    #[msg("Nothing to refund")]
    NothingToRefund,
    #[msg("Accounting underflow")]
    AccountingUnderflow,
    #[msg("Spawn already closed")]
    SpawnAlreadyClosed,
    #[msg("User is banned from this thread")]
    UserBanned,
    #[msg("Deposit is not rejected")]
    DepositNotRejected,
    #[msg("Deposit is not approved")]
    DepositNotApproved,
    #[msg("Thread escrow has insufficient available lamports")]
    InsufficientEscrowBalance,
    #[msg("min_approved_wallets is outside allowed bounds")]
    MinApprovedWalletsOutOfBounds,
    #[msg("spawn_target_lamports is outside allowed bounds")]
    SpawnTargetOutOfBounds,
    #[msg("max_wallet_share_bps is outside allowed bounds")]
    MaxWalletShareOutOfBounds,
    #[msg("Spawn target has not been reached")]
    SpawnTargetNotReached,
    #[msg("Minimum approved wallets requirement has not been reached")]
    MinApprovedWalletsNotReached,
}
