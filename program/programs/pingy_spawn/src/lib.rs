use anchor_lang::prelude::*;
use anchor_lang::system_program;

declare_id!("Pingy1111111111111111111111111111111111111");

#[program]
pub mod pingy_spawn {
    use super::*;

    pub fn initialize_thread(ctx: Context<InitializeThread>, thread_id: String) -> Result<()> {
        require!(!thread_id.is_empty(), PingyError::InvalidThreadId);

        let thread = &mut ctx.accounts.thread;
        thread.thread_id = thread_id.clone();
        thread.admin_pubkey = ctx.accounts.admin.key();
        thread.spawn_state = SpawnState::Open;
        thread.participants = Vec::new();

        let spawn_pool = &mut ctx.accounts.spawn_pool;
        spawn_pool.thread_id = thread_id;

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

        {
            let deposit = &mut ctx.accounts.deposit;

            if deposit.rejected_once {
                return err!(PingyError::DepositRejectedPermanently);
            }

            if deposit.thread_id.is_empty() {
                deposit.thread_id = thread_id;
                deposit.user_pubkey = ctx.accounts.user.key();
                deposit.status = DepositStatus::Pending;
                deposit.amount_recorded_lamports = 0;
                deposit.rejected_once = false;
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
                to: ctx.accounts.deposit.to_account_info(),
            },
        );
        system_program::transfer(transfer_ctx, amount_lamports)?;

        let deposit = &mut ctx.accounts.deposit;
        deposit.amount_recorded_lamports = deposit
            .amount_recorded_lamports
            .checked_add(amount_lamports)
            .ok_or(PingyError::AmountOverflow)?;

        if ctx.accounts.user.key() == thread.admin_pubkey {
            deposit.status = DepositStatus::Approved;
        } else if deposit.status != DepositStatus::Approved {
            deposit.status = DepositStatus::Pending;
        }

        if !thread.participants.contains(&ctx.accounts.user.key()) {
            thread.participants.push(ctx.accounts.user.key());
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
        require!(
            !deposit.rejected_once,
            PingyError::DepositRejectedPermanently
        );

        deposit.status = DepositStatus::Approved;
        Ok(())
    }

    pub fn reject_and_refund(
        ctx: Context<AdminRefund>,
        thread_id: String,
        user_pubkey: Pubkey,
    ) -> Result<()> {
        process_refund(
            &ctx.accounts.thread,
            &mut ctx.accounts.deposit,
            &ctx.accounts.user.to_account_info(),
            thread_id,
            user_pubkey,
            true,
            DepositStatus::Rejected,
        )
    }

    pub fn unping_withdraw(ctx: Context<UserWithdraw>, thread_id: String) -> Result<()> {
        let user_key = ctx.accounts.user.key();
        process_refund(
            &ctx.accounts.thread,
            &mut ctx.accounts.deposit,
            &ctx.accounts.user.to_account_info(),
            thread_id,
            user_key,
            false,
            DepositStatus::Withdrawn,
        )
    }
}

fn process_refund<'info>(
    thread: &Account<'info, Thread>,
    deposit: &mut Account<'info, Deposit>,
    user: &AccountInfo<'info>,
    thread_id: String,
    user_pubkey: Pubkey,
    rejected_once: bool,
    new_status: DepositStatus,
) -> Result<()> {
    require!(thread.thread_id == thread_id, PingyError::ThreadMismatch);
    require!(deposit.user_pubkey == user_pubkey, PingyError::UserMismatch);

    let min_balance = Rent::get()?.minimum_balance(Deposit::SIZE);
    let deposit_info = deposit.to_account_info();
    let current_balance = deposit_info.lamports();
    let refundable = current_balance.saturating_sub(min_balance);
    require!(refundable > 0, PingyError::NothingToRefund);

    **deposit_info.try_borrow_mut_lamports()? -= refundable;
    **user.try_borrow_mut_lamports()? += refundable;

    deposit.amount_recorded_lamports = deposit.amount_recorded_lamports.saturating_sub(refundable);
    deposit.status = new_status;
    if rejected_once {
        deposit.rejected_once = true;
    }

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
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(thread_id: String, user_pubkey: Pubkey)]
pub struct ApproveUser<'info> {
    #[account(mut, address = thread.admin_pubkey)]
    pub admin: Signer<'info>,
    #[account(
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
    /// CHECK: Must match deposit.user_pubkey, validated in handler.
    #[account(mut, address = user_pubkey)]
    pub user: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(thread_id: String)]
pub struct UserWithdraw<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        seeds = [b"thread", thread_id.as_bytes()],
        bump
    )]
    pub thread: Account<'info, Thread>,
    #[account(
        mut,
        seeds = [b"deposit", thread_id.as_bytes(), user.key().as_ref()],
        bump
    )]
    pub deposit: Account<'info, Deposit>,
}

#[account]
pub struct Thread {
    pub thread_id: String,
    pub admin_pubkey: Pubkey,
    pub spawn_state: SpawnState,
    pub participants: Vec<Pubkey>,
}

impl Thread {
    pub const MAX_THREAD_ID_LEN: usize = 64;
    pub const MAX_PARTICIPANTS: usize = 1024;
    pub const LEN: usize = 4 + Self::MAX_THREAD_ID_LEN + 32 + 1 + 4 + (Self::MAX_PARTICIPANTS * 32);
}

#[account]
pub struct Deposit {
    pub thread_id: String,
    pub user_pubkey: Pubkey,
    pub status: DepositStatus,
    pub rejected_once: bool,
    pub amount_recorded_lamports: u64,
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
}
