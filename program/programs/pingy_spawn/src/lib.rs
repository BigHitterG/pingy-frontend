use anchor_lang::prelude::*;
use anchor_lang::system_program;

declare_id!("FSvYheeHSLjU6UKqka5AnMeaPwsQBrLm8dCL4VtFpf5R");

pub const SPAWN_FEE_BPS: u64 = 100;
pub const BPS_DENOM: u64 = 10_000;

#[program]
pub mod pingy_spawn {
    use super::*;

    pub fn initialize_thread(ctx: Context<InitializeThread>, thread_id: String) -> Result<()> {
        require!(!thread_id.is_empty(), PingyError::InvalidThreadId);

        let thread = &mut ctx.accounts.thread;
        thread.thread_id = thread_id.clone();
        thread.admin_pubkey = ctx.accounts.admin.key();
        thread.spawn_state = SpawnState::Open;
        thread.pending_count = 0;
        thread.approved_count = 0;
        thread.total_allocated_lamports = 0;

        let spawn_pool = &mut ctx.accounts.spawn_pool;
        spawn_pool.thread_id = thread_id;

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

        let (ban_pda, _ban_bump) = Pubkey::find_program_address(
            &[
                b"ban",
                thread_id.as_bytes(),
                ctx.accounts.user.key().as_ref(),
            ],
            ctx.program_id,
        );
        if ctx
            .remaining_accounts
            .iter()
            .any(|account_info| account_info.key() == ban_pda)
        {
            return err!(PingyError::UserBanned);
        }

        let thread = &mut ctx.accounts.thread;
        require!(thread.thread_id == thread_id, PingyError::ThreadMismatch);

        let mut is_new_deposit = false;
        {
            let deposit = &mut ctx.accounts.deposit;

            if deposit.thread_id.is_empty() {
                is_new_deposit = true;
                deposit.thread_id = thread_id;
                deposit.user_pubkey = ctx.accounts.user.key();
                deposit.status = DepositStatus::Pending;
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
                to: ctx.accounts.user_vault.to_account_info(),
            },
        );
        system_program::transfer(transfer_ctx, amount_lamports)?;

        let user_vault = &mut ctx.accounts.user_vault;
        if user_vault.user_pubkey == Pubkey::default() {
            user_vault.user_pubkey = ctx.accounts.user.key();
            user_vault.refundable_lamports = 0;
        }
        require!(
            user_vault.user_pubkey == ctx.accounts.user.key(),
            PingyError::UserMismatch
        );

        let deposit = &mut ctx.accounts.deposit;
        deposit.allocated_lamports = deposit
            .allocated_lamports
            .checked_add(amount_lamports)
            .ok_or(PingyError::AmountOverflow)?;
        thread.total_allocated_lamports = thread
            .total_allocated_lamports
            .checked_add(amount_lamports)
            .ok_or(PingyError::AmountOverflow)?;

        let previous_status = deposit.status;
        if ctx.accounts.user.key() == thread.admin_pubkey {
            deposit.status = DepositStatus::Approved;
        } else if deposit.status != DepositStatus::Approved {
            deposit.status = DepositStatus::Pending;
        }
        if is_new_deposit {
            thread.increment_status_count(deposit.status)?;
        } else {
            thread.apply_status_transition(previous_status, deposit.status)?;
        }

        Ok(())
    }

    /// Executes spawn using lamports supplied by the admin signer.
    ///
    /// Current behavior is intentionally a placeholder: this instruction does
    /// not sweep approved user deposits into `spawn_pool`. It only splits the
    /// admin-funded amount into fee + net.
    ///
    /// If/when spawn should be funded from pooled deposits, we need an explicit
    /// on-chain aggregation flow (e.g. per-user settlement instructions or a
    /// merkle/proof-based claim model), because the thread account no longer
    /// stores a participants vector to iterate over on chain.
    pub fn execute_spawn(
        ctx: Context<ExecuteSpawn>,
        thread_id: String,
        admin_funded_total_to_use: u64,
    ) -> Result<()> {
        require!(admin_funded_total_to_use > 0, PingyError::InvalidAmount);

        let thread = &mut ctx.accounts.thread;
        require!(thread.thread_id == thread_id, PingyError::ThreadMismatch);
        require!(
            thread.spawn_state == SpawnState::Open,
            PingyError::SpawnAlreadyClosed
        );

        let fee = admin_funded_total_to_use
            .checked_mul(SPAWN_FEE_BPS)
            .ok_or(PingyError::AmountOverflow)?
            .checked_div(BPS_DENOM)
            .ok_or(PingyError::AmountOverflow)?;
        let net = admin_funded_total_to_use
            .checked_sub(fee)
            .ok_or(PingyError::AccountingUnderflow)?;

        let fee_transfer_ctx = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.admin.to_account_info(),
                to: ctx.accounts.fee_vault.to_account_info(),
            },
        );
        system_program::transfer(fee_transfer_ctx, fee)?;

        let net_transfer_ctx = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.admin.to_account_info(),
                to: ctx.accounts.spawn_pool.to_account_info(),
            },
        );
        system_program::transfer(net_transfer_ctx, net)?;

        thread.spawn_state = SpawnState::Closed;

        emit!(SpawnExecuted {
            thread_id,
            total_to_use: admin_funded_total_to_use,
            fee,
            net,
        });

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
        thread.apply_status_transition(previous_status, deposit.status)?;
        Ok(())
    }

    pub fn reject_and_refund(
        ctx: Context<AdminRefund>,
        thread_id: String,
        user_pubkey: Pubkey,
    ) -> Result<()> {
        let thread = &ctx.accounts.thread;
        require!(thread.thread_id == thread_id, PingyError::ThreadMismatch);

        let deposit = &mut ctx.accounts.deposit;
        require!(deposit.user_pubkey == user_pubkey, PingyError::UserMismatch);

        let previous_status = deposit.status;
        deposit.status = DepositStatus::Rejected;
        deposit.rejected_once = true;
        let ban_bump = ctx.bumps.ban;
        ctx.accounts.ban.bump = ban_bump;

        let thread = &mut ctx.accounts.thread;
        thread.apply_status_transition(previous_status, deposit.status)?;

        Ok(())
    }

    pub fn unping_withdraw(ctx: Context<UserWithdraw>, thread_id: String) -> Result<()> {
        let thread = &ctx.accounts.thread;
        require!(thread.thread_id == thread_id, PingyError::ThreadMismatch);

        let user_key = ctx.accounts.user.key();
        let deposit = &mut ctx.accounts.deposit;
        require!(deposit.user_pubkey == user_key, PingyError::UserMismatch);

        let allocated_before = deposit.allocated_lamports;
        transfer_from_user_vault_to_user(
            &ctx.accounts.user_vault,
            &ctx.accounts.user,
            allocated_before,
        )?;
        let previous_status = deposit.status;
        let thread = &mut ctx.accounts.thread;
        thread.total_allocated_lamports = thread
            .total_allocated_lamports
            .checked_sub(allocated_before)
            .ok_or(PingyError::AccountingUnderflow)?;
        deposit.allocated_lamports = 0;
        deposit.status = DepositStatus::Withdrawn;
        thread.apply_status_transition(previous_status, deposit.status)?;

        Ok(())
    }

    pub fn withdraw_rejected(ctx: Context<UserWithdraw>, thread_id: String) -> Result<()> {
        let thread = &ctx.accounts.thread;
        require!(thread.thread_id == thread_id, PingyError::ThreadMismatch);

        let user_key = ctx.accounts.user.key();
        let deposit = &mut ctx.accounts.deposit;
        require!(deposit.user_pubkey == user_key, PingyError::UserMismatch);
        require!(
            deposit.status == DepositStatus::Rejected,
            PingyError::DepositNotRejected
        );

        let allocated_before = deposit.allocated_lamports;
        transfer_from_user_vault_to_user(
            &ctx.accounts.user_vault,
            &ctx.accounts.user,
            allocated_before,
        )?;
        let previous_status = deposit.status;
        let thread = &mut ctx.accounts.thread;
        thread.total_allocated_lamports = thread
            .total_allocated_lamports
            .checked_sub(allocated_before)
            .ok_or(PingyError::AccountingUnderflow)?;
        deposit.allocated_lamports = 0;
        deposit.status = DepositStatus::Withdrawn;
        thread.apply_status_transition(previous_status, deposit.status)?;

        Ok(())
    }

    pub fn refund_all(ctx: Context<RefundAll>) -> Result<()> {
        let user_vault = &mut ctx.accounts.user_vault;
        require!(
            user_vault.user_pubkey == ctx.accounts.user.key(),
            PingyError::UserMismatch
        );

        let min_balance = Rent::get()?.minimum_balance(8 + UserVault::SIZE);
        let vault_info = user_vault.to_account_info();
        let available = vault_info.lamports().saturating_sub(min_balance);
        let payout = user_vault.refundable_lamports.min(available);
        require!(payout > 0, PingyError::NothingToRefund);

        **vault_info.try_borrow_mut_lamports()? -= payout;
        **ctx
            .accounts
            .user
            .to_account_info()
            .try_borrow_mut_lamports()? += payout;

        user_vault.refundable_lamports = user_vault.refundable_lamports.saturating_sub(payout);

        Ok(())
    }
}

fn transfer_from_user_vault_to_user(
    user_vault: &Account<UserVault>,
    user: &Signer,
    amount: u64,
) -> Result<()> {
    let min_balance = Rent::get()?.minimum_balance(8 + UserVault::SIZE);
    let vault_info = user_vault.to_account_info();
    let available = vault_info.lamports().saturating_sub(min_balance);
    require!(available >= amount, PingyError::InsufficientVaultBalance);

    **vault_info.try_borrow_mut_lamports()? -= amount;
    **user.to_account_info().try_borrow_mut_lamports()? += amount;

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
        init_if_needed,
        payer = user,
        space = 8 + UserVault::SIZE,
        seeds = [b"vault", user.key().as_ref()],
        bump
    )]
    pub user_vault: Account<'info, UserVault>,
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
pub struct AdminRefund<'info> {
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
    #[account(
        init_if_needed,
        payer = admin,
        space = 8 + Ban::LEN,
        seeds = [b"ban", thread_id.as_bytes(), user_pubkey.as_ref()],
        bump
    )]
    pub ban: Account<'info, Ban>,
    pub system_program: Program<'info, System>,
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
        seeds = [b"vault", user.key().as_ref()],
        bump,
        constraint = user_vault.user_pubkey == user.key() @ PingyError::UserMismatch
    )]
    pub user_vault: Account<'info, UserVault>,
    #[account(
        mut,
        seeds = [b"deposit", thread_id.as_bytes(), user.key().as_ref()],
        bump,
        close = user
    )]
    pub deposit: Account<'info, Deposit>,
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

#[derive(Accounts)]
pub struct RefundAll<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        mut,
        seeds = [b"vault", user.key().as_ref()],
        bump
    )]
    pub user_vault: Account<'info, UserVault>,
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
}

impl Thread {
    pub const MAX_THREAD_ID_LEN: usize = 64;
    pub const LEN: usize = 4 + Self::MAX_THREAD_ID_LEN + 32 + 1 + 4 + 4 + 8;

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
pub struct Deposit {
    pub thread_id: String,
    pub user_pubkey: Pubkey,
    pub status: DepositStatus,
    pub rejected_once: bool,
    pub allocated_lamports: u64,
}

impl Deposit {
    pub const MAX_THREAD_ID_LEN: usize = 64;
    pub const SIZE: usize = 4 + Self::MAX_THREAD_ID_LEN + 32 + 1 + 1 + 8;
    pub const LEN: usize = Self::SIZE;
}

#[account]
pub struct SpawnPool {
    pub thread_id: String,
}

#[account]
pub struct UserVault {
    pub user_pubkey: Pubkey,
    pub refundable_lamports: u64,
}

#[account]
pub struct FeeVault {
    pub initialized: bool,
}

#[account]
pub struct Ban {
    pub bump: u8,
}

impl UserVault {
    pub const SIZE: usize = 32 + 8;
}

impl FeeVault {
    pub const SIZE: usize = 1;
}

impl Ban {
    pub const LEN: usize = 1;
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
    Rejected,
    Withdrawn,
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
    #[msg("User vault has insufficient available lamports")]
    InsufficientVaultBalance,
}
