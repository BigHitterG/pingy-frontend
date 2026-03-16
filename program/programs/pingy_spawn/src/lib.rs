use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount, Transfer};

declare_id!("FSvYheeHSLjU6UKqka5AnMeaPwsQBrLm8dCL4VtFpf5R");

pub const SPAWN_FEE_BPS: u64 = 100;
pub const BPS_DENOM: u64 = 10_000;
pub const LAMPORTS_PER_SOL: u64 = 1_000_000_000;
pub const TOTAL_SUPPLY: u64 = 1_000_000_000;
pub const VIRTUAL_SOL_RESERVE_INITIAL: u64 = 30 * LAMPORTS_PER_SOL;
pub const VIRTUAL_TOKEN_RESERVE_INITIAL: u64 = TOTAL_SUPPLY;
pub const POST_SPAWN_TRADING_FEE_BPS: u16 = 100;
pub const TOKEN_DECIMALS: u8 = 0;

pub const MIN_APPROVED_WALLETS_MIN: u32 = 10;
pub const MIN_APPROVED_WALLETS_MAX: u32 = 50;
pub const SPAWN_TARGET_MIN_LAMPORTS: u64 = LAMPORTS_PER_SOL;
pub const SPAWN_TARGET_MAX_LAMPORTS: u64 = 100 * LAMPORTS_PER_SOL;
pub const GRADUATION_TARGET_LAMPORTS: u64 = 78 * LAMPORTS_PER_SOL;
pub const MAX_WALLET_SHARE_BPS_MIN: u16 = 200;
pub const MAX_WALLET_SHARE_BPS_MAX: u16 = 2000;
pub const LAUNCH_MODE_SPAWN: u8 = 0;
pub const LAUNCH_MODE_INSTANT: u8 = 1;

#[program]
pub mod pingy_spawn {
    use super::*;

    pub fn initialize_thread_core(
        ctx: Context<InitializeThreadCore>,
        thread_id: String,
        min_approved_wallets: u32,
        spawn_target_lamports: u64,
        max_wallet_share_bps: u16,
        launch_mode: u8,
    ) -> Result<()> {
        require!(!thread_id.is_empty(), PingyError::InvalidThreadId);
        require!(
            launch_mode == LAUNCH_MODE_SPAWN || launch_mode == LAUNCH_MODE_INSTANT,
            PingyError::InvalidLaunchMode
        );

        if launch_mode == LAUNCH_MODE_SPAWN {
            require!(
                (MIN_APPROVED_WALLETS_MIN..=MIN_APPROVED_WALLETS_MAX)
                    .contains(&min_approved_wallets),
                PingyError::MinApprovedWalletsOutOfBounds
            );
            require!(
                (SPAWN_TARGET_MIN_LAMPORTS..=SPAWN_TARGET_MAX_LAMPORTS)
                    .contains(&spawn_target_lamports),
                PingyError::SpawnTargetOutOfBounds
            );
            require!(
                (MAX_WALLET_SHARE_BPS_MIN..=MAX_WALLET_SHARE_BPS_MAX)
                    .contains(&max_wallet_share_bps),
                PingyError::MaxWalletShareOutOfBounds
            );
        }

        let thread = &mut ctx.accounts.thread;
        thread.thread_id = thread_id.clone();
        thread.admin_pubkey = ctx.accounts.admin.key();
        thread.spawn_state = SpawnState::Open;
        thread.curve_initialized = false;
        thread.launch_mode = launch_mode;
        thread.pending_count = 0;
        thread.approved_count = 0;
        thread.total_allocated_lamports = 0;
        thread.total_escrow_lamports = 0;
        thread.min_approved_wallets = min_approved_wallets;
        thread.spawn_target_lamports = spawn_target_lamports;
        thread.max_wallet_share_bps = max_wallet_share_bps;

        let curve = &mut ctx.accounts.curve;
        curve.thread_id = thread_id.clone();
        initialize_curve_state(
            curve,
            TOTAL_SUPPLY,
            POST_SPAWN_TRADING_FEE_BPS,
            GRADUATION_TARGET_LAMPORTS,
        );
        curve.curve_authority_bump = ctx.bumps.curve_authority;

        let spawn_pool = &mut ctx.accounts.spawn_pool;
        spawn_pool.thread_id = thread_id.clone();

        let thread_escrow = &mut ctx.accounts.thread_escrow;
        thread_escrow.thread_id = thread_id.clone();

        Ok(())
    }

    pub fn initialize_thread_assets(
        ctx: Context<InitializeThreadAssets>,
        thread_id: String,
    ) -> Result<()> {
        let thread = &mut ctx.accounts.thread;
        require!(thread.thread_id == thread_id, PingyError::ThreadMismatch);

        let curve = &mut ctx.accounts.curve;
        require!(curve.thread_id == thread_id, PingyError::ThreadMismatch);

        initialize_mint_if_needed(curve, &ctx.accounts.mint, &ctx.accounts.curve_authority)?;
        initialize_curve_token_vault_if_needed(
            curve,
            &ctx.accounts.curve_token_vault,
            &ctx.accounts.curve_authority,
        )?;

        let fee_vault = &mut ctx.accounts.fee_vault;
        if !fee_vault.initialized {
            fee_vault.initialized = true;
        }

        if thread.launch_mode == LAUNCH_MODE_INSTANT {
            mint_total_supply_to_curve_vault(
                &thread_id,
                &ctx.accounts.curve,
                &ctx.accounts.curve_authority,
                &ctx.accounts.mint,
                &ctx.accounts.curve_token_vault,
                &ctx.accounts.token_program,
            )?;

            let curve = &mut ctx.accounts.curve;
            curve.state = CurveLifecycle::Bonding;
            thread.curve_initialized = true;
            thread.spawn_state = SpawnState::Closed;
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
                deposit.spawn_token_allocation = 0;
                deposit.spawn_tokens_claimed = 0;
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

        let deposit_rent_lamports = if is_new_deposit {
            ctx.accounts.deposit.to_account_info().lamports()
        } else {
            0
        };
        let net_contribution_lamports = amount_lamports.saturating_sub(deposit_rent_lamports);
        require!(net_contribution_lamports > 0, PingyError::PingAmountTooSmall);

        if deposit_rent_lamports > 0 {
            transfer_from_thread_escrow_to_account(
                &ctx.accounts.thread_escrow.to_account_info(),
                &ctx.accounts.user.to_account_info(),
                deposit_rent_lamports,
            )?;
        }

        msg!(
            "ping_deposit gross={} rent={} net={} user={} escrow={} thread={}",
            amount_lamports,
            deposit_rent_lamports,
            net_contribution_lamports,
            ctx.accounts.user.key(),
            ctx.accounts.thread_escrow.key(),
            thread_id
        );
        thread.total_escrow_lamports = thread
            .total_escrow_lamports
            .checked_add(net_contribution_lamports)
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
                .checked_add(net_contribution_lamports)
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

    pub fn execute_spawn<'info>(
        ctx: Context<'_, '_, 'info, 'info, ExecuteSpawn<'info>>,
        thread_id: String,
    ) -> Result<()> {
        {
            let thread = &ctx.accounts.thread;
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
        }

        let use_amt = ctx.accounts.thread.spawn_target_lamports;
        let fee = use_amt
            .checked_mul(SPAWN_FEE_BPS)
            .ok_or(PingyError::AmountOverflow)?
            .checked_div(BPS_DENOM)
            .ok_or(PingyError::AmountOverflow)?;
        let net = use_amt
            .checked_sub(fee)
            .ok_or(PingyError::AccountingUnderflow)?;

        mint_total_supply_to_curve_vault(
            &thread_id,
            &ctx.accounts.curve,
            &ctx.accounts.curve_authority,
            &ctx.accounts.mint,
            &ctx.accounts.curve_token_vault,
            &ctx.accounts.token_program,
        )?;

        let tokens_out = {
            let curve = &mut ctx.accounts.curve;
            let tokens_out = apply_curve_buy(net, curve)?;
            curve.opening_buy_lamports = net;
            curve.opening_buy_tokens = tokens_out;
            curve.state = CurveLifecycle::Bonding;
            if maybe_graduate_curve(curve) {
                emit!(CurveGraduated {
                    thread_id: thread_id.clone(),
                    final_sol_reserve: curve.real_sol_reserve,
                    final_token_reserve: curve.real_token_reserve,
                });
            }
            tokens_out
        };

        allocate_spawn_tokens_pro_rata(
            &mut ctx.accounts.thread,
            &thread_id,
            use_amt,
            tokens_out,
            ctx.remaining_accounts,
        )?;

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

        let thread = &mut ctx.accounts.thread;
        thread.total_allocated_lamports = thread
            .total_allocated_lamports
            .checked_sub(use_amt)
            .ok_or(PingyError::AccountingUnderflow)?;
        thread.total_escrow_lamports = thread
            .total_escrow_lamports
            .checked_sub(use_amt)
            .ok_or(PingyError::AccountingUnderflow)?;
        thread.curve_initialized = true;
        thread.spawn_state = SpawnState::Closed;

        emit!(SpawnExecuted {
            thread_id,
            total_to_use: use_amt,
            fee,
            net,
            opening_buy_tokens: tokens_out,
        });

        Ok(())
    }

    pub fn claim_spawn_tokens(ctx: Context<ClaimSpawnTokens>, thread_id: String) -> Result<()> {
        require!(
            ctx.accounts.thread.thread_id == thread_id,
            PingyError::ThreadMismatch
        );
        require!(
            ctx.accounts.curve.thread_id == thread_id,
            PingyError::ThreadMismatch
        );
        require!(
            ctx.accounts.deposit.thread_id == thread_id,
            PingyError::ThreadMismatch
        );
        require!(
            ctx.accounts.deposit.user_pubkey == ctx.accounts.user.key(),
            PingyError::UserMismatch
        );
        require!(
            ctx.accounts.thread.spawn_state == SpawnState::Closed,
            PingyError::SpawnNotClosed
        );
        require!(
            ctx.accounts.curve.state == CurveLifecycle::Bonding
                || ctx.accounts.curve.state == CurveLifecycle::Bonded,
            PingyError::InvalidCurveState
        );

        let claimable = ctx
            .accounts
            .deposit
            .spawn_token_allocation
            .checked_sub(ctx.accounts.deposit.spawn_tokens_claimed)
            .ok_or(PingyError::AccountingUnderflow)?;
        require!(claimable > 0, PingyError::NothingToClaim);

        let signer_seeds: &[&[&[u8]]] = &[&[
            b"curve_authority",
            thread_id.as_bytes(),
            &[ctx.accounts.curve.curve_authority_bump],
        ]];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.curve_token_vault.to_account_info(),
                    to: ctx.accounts.user_token_account.to_account_info(),
                    authority: ctx.accounts.curve_authority.to_account_info(),
                },
                signer_seeds,
            ),
            claimable,
        )?;

        ctx.accounts.deposit.spawn_tokens_claimed = ctx
            .accounts
            .deposit
            .spawn_tokens_claimed
            .checked_add(claimable)
            .ok_or(PingyError::AmountOverflow)?;

        Ok(())
    }

    pub fn buy(ctx: Context<Buy>, thread_id: String, amount_lamports: u64) -> Result<()> {
        require!(
            ctx.accounts.thread.thread_id == thread_id,
            PingyError::ThreadMismatch
        );
        require!(
            ctx.accounts.curve.thread_id == thread_id,
            PingyError::ThreadMismatch
        );
        require!(
            ctx.accounts.curve.mint == ctx.accounts.mint.key(),
            PingyError::ThreadMismatch
        );
        require!(
            ctx.accounts.curve.curve_token_vault == ctx.accounts.curve_token_vault.key(),
            PingyError::ThreadMismatch
        );
        require!(
            ctx.accounts.thread.spawn_state == SpawnState::Closed,
            PingyError::SpawnNotClosed
        );
        require!(
            ctx.accounts.curve.state == CurveLifecycle::Bonding,
            PingyError::InvalidCurveState
        );
        require!(amount_lamports > 0, PingyError::InvalidAmount);

        let transfer_ctx = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.user.to_account_info(),
                to: ctx.accounts.spawn_pool.to_account_info(),
            },
        );
        system_program::transfer(transfer_ctx, amount_lamports)?;

        let (net_lamports, fee_lamports) =
            apply_trade_fee(amount_lamports, ctx.accounts.curve.trade_fee_bps)?;
        transfer_from_program_owned_account_to_account(
            &ctx.accounts.spawn_pool.to_account_info(),
            &ctx.accounts.fee_vault.to_account_info(),
            fee_lamports,
        )?;

        let tokens_out = apply_curve_buy(net_lamports, &mut ctx.accounts.curve)?;
        if maybe_graduate_curve(&mut ctx.accounts.curve) {
            emit!(CurveGraduated {
                thread_id: thread_id.clone(),
                final_sol_reserve: ctx.accounts.curve.real_sol_reserve,
                final_token_reserve: ctx.accounts.curve.real_token_reserve,
            });
        }

        let signer_seeds: &[&[&[u8]]] = &[&[
            b"curve_authority",
            thread_id.as_bytes(),
            &[ctx.accounts.curve.curve_authority_bump],
        ]];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.curve_token_vault.to_account_info(),
                    to: ctx.accounts.user_token_account.to_account_info(),
                    authority: ctx.accounts.curve_authority.to_account_info(),
                },
                signer_seeds,
            ),
            tokens_out,
        )?;

        emit!(BuyExecuted {
            thread_id,
            user: ctx.accounts.user.key(),
            gross_sol: amount_lamports,
            fee_sol: fee_lamports,
            net_sol: net_lamports,
            tokens_out,
        });

        Ok(())
    }

    pub fn sell(ctx: Context<Sell>, thread_id: String, token_amount: u64) -> Result<()> {
        require!(
            ctx.accounts.thread.thread_id == thread_id,
            PingyError::ThreadMismatch
        );
        require!(
            ctx.accounts.curve.thread_id == thread_id,
            PingyError::ThreadMismatch
        );
        require!(
            ctx.accounts.curve.mint == ctx.accounts.mint.key(),
            PingyError::ThreadMismatch
        );
        require!(
            ctx.accounts.curve.curve_token_vault == ctx.accounts.curve_token_vault.key(),
            PingyError::ThreadMismatch
        );
        require!(
            ctx.accounts.thread.spawn_state == SpawnState::Closed,
            PingyError::SpawnNotClosed
        );
        require!(
            ctx.accounts.curve.state == CurveLifecycle::Bonding,
            PingyError::InvalidCurveState
        );
        require!(token_amount > 0, PingyError::InvalidAmount);
        require!(
            ctx.accounts.user_token_account.owner == ctx.accounts.user.key(),
            PingyError::InvalidUserTokenAccount
        );
        require!(
            ctx.accounts.user_token_account.mint == ctx.accounts.mint.key(),
            PingyError::InvalidUserTokenAccount
        );

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.user_token_account.to_account_info(),
                    to: ctx.accounts.curve_token_vault.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            token_amount,
        )?;

        let gross_sol_out = curve_sell_sol(token_amount, &ctx.accounts.curve)?;
        let (net_sol_out, fee_sol) =
            apply_trade_fee(gross_sol_out, ctx.accounts.curve.trade_fee_bps)?;

        apply_curve_sell(token_amount, &mut ctx.accounts.curve)?;

        transfer_from_program_owned_account_to_account(
            &ctx.accounts.spawn_pool.to_account_info(),
            &ctx.accounts.fee_vault.to_account_info(),
            fee_sol,
        )?;
        transfer_from_program_owned_account_to_account(
            &ctx.accounts.spawn_pool.to_account_info(),
            &ctx.accounts.user.to_account_info(),
            net_sol_out,
        )?;

        emit!(SellExecuted {
            thread_id,
            user: ctx.accounts.user.key(),
            tokens_in: token_amount,
            gross_sol_out,
            fee_sol,
            net_sol_out,
        });

        Ok(())
    }
}

fn allocate_spawn_tokens_pro_rata<'info>(
    thread: &mut Account<Thread>,
    thread_id: &str,
    use_amt: u64,
    tokens_out: u64,
    remaining_accounts: &'info [AccountInfo<'info>],
) -> Result<()> {
    let mut remaining_lamports = use_amt;
    let mut remaining_tokens = tokens_out;

    for account_info in remaining_accounts.iter() {
        let mut deposit: Account<Deposit> = Account::try_from(account_info)?;
        require!(
            deposit.thread_id == thread_id,
            PingyError::InvalidDepositRemainingAccount
        );
        require!(
            deposit.status == DepositStatus::Approved,
            PingyError::DepositNotApproved
        );

        let allocated = deposit.allocated_lamports;
        require!(
            allocated <= remaining_lamports,
            PingyError::InvalidDepositRemainingAccount
        );

        let wallet_tokens = if allocated == 0 {
            0
        } else if allocated == remaining_lamports {
            remaining_tokens
        } else {
            ((allocated as u128)
                .checked_mul(remaining_tokens as u128)
                .ok_or(PingyError::AmountOverflow)?
                .checked_div(remaining_lamports as u128)
                .ok_or(PingyError::AmountOverflow)?) as u64
        };

        let previous_status = deposit.status;
        deposit.spawn_token_allocation = wallet_tokens;
        deposit.allocated_lamports = 0;
        deposit.status = DepositStatus::Converted;
        thread.apply_status_transition(previous_status, deposit.status)?;

        remaining_lamports = remaining_lamports
            .checked_sub(allocated)
            .ok_or(PingyError::AccountingUnderflow)?;
        remaining_tokens = remaining_tokens
            .checked_sub(wallet_tokens)
            .ok_or(PingyError::AccountingUnderflow)?;
    }

    require!(
        remaining_lamports == 0,
        PingyError::MissingApprovedDepositAccounts
    );

    Ok(())
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

fn initialize_curve_state(
    curve: &mut Curve,
    total_supply: u64,
    trade_fee_bps: u16,
    graduation_target_lamports: u64,
) {
    curve.state = CurveLifecycle::PreSpawn;
    curve.mint = Pubkey::default();
    curve.mint_decimals = TOKEN_DECIMALS;
    curve.curve_token_vault = Pubkey::default();
    curve.curve_authority_bump = 0;
    curve.total_supply = total_supply;
    curve.virtual_sol_reserve = VIRTUAL_SOL_RESERVE_INITIAL;
    curve.virtual_token_reserve = VIRTUAL_TOKEN_RESERVE_INITIAL;
    curve.real_sol_reserve = 0;
    curve.real_token_reserve = total_supply;
    curve.opening_buy_lamports = 0;
    curve.opening_buy_tokens = 0;
    curve.trade_fee_bps = trade_fee_bps;
    curve.graduation_target_lamports = graduation_target_lamports;
}

fn initialize_mint_if_needed<'info>(
    curve: &mut Curve,
    mint: &Account<'info, Mint>,
    curve_authority: &UncheckedAccount<'info>,
) -> Result<()> {
    let mint_authority = mint
        .mint_authority
        .ok_or(PingyError::InvalidCurveMintAuthority)?;
    require!(
        mint_authority == curve_authority.key(),
        PingyError::InvalidCurveMintAuthority
    );

    curve.mint = mint.key();
    curve.mint_decimals = mint.decimals;

    Ok(())
}

fn initialize_curve_token_vault_if_needed<'info>(
    curve: &mut Curve,
    curve_token_vault: &Account<'info, TokenAccount>,
    curve_authority: &UncheckedAccount<'info>,
) -> Result<()> {
    require!(
        curve_token_vault.mint == curve.mint,
        PingyError::CurveTokenVaultMintMismatch
    );
    require!(
        curve_token_vault.owner == curve_authority.key(),
        PingyError::CurveTokenVaultMintMismatch
    );

    curve.curve_token_vault = curve_token_vault.key();

    Ok(())
}

fn mint_total_supply_to_curve_vault<'info>(
    thread_id: &str,
    curve: &Curve,
    curve_authority: &UncheckedAccount<'info>,
    mint: &Account<'info, Mint>,
    curve_token_vault: &Account<'info, TokenAccount>,
    token_program: &Program<'info, Token>,
) -> Result<()> {
    if curve_token_vault.amount > 0 {
        return Ok(());
    }

    let signer_seeds: &[&[&[u8]]] = &[&[
        b"curve_authority",
        thread_id.as_bytes(),
        &[curve.curve_authority_bump],
    ]];

    token::mint_to(
        CpiContext::new_with_signer(
            token_program.to_account_info(),
            MintTo {
                mint: mint.to_account_info(),
                to: curve_token_vault.to_account_info(),
                authority: curve_authority.to_account_info(),
            },
            signer_seeds,
        ),
        curve.total_supply,
    )?;

    Ok(())
}

fn apply_trade_fee(amount: u64, fee_bps: u16) -> Result<(u64, u64)> {
    let fee = amount
        .checked_mul(fee_bps as u64)
        .ok_or(PingyError::AmountOverflow)?
        .checked_div(BPS_DENOM)
        .ok_or(PingyError::AmountOverflow)?;
    let net = amount
        .checked_sub(fee)
        .ok_or(PingyError::AccountingUnderflow)?;
    Ok((net, fee))
}

fn curve_buy_tokens(sol_in: u64, curve: &Curve) -> Result<u64> {
    if sol_in == 0 {
        return Ok(0);
    }

    require!(
        curve.virtual_sol_reserve > 0,
        PingyError::InvalidCurveReserves
    );
    require!(
        curve.virtual_token_reserve > 0,
        PingyError::InvalidCurveReserves
    );

    let x = curve.virtual_sol_reserve as u128;
    let y = curve.virtual_token_reserve as u128;
    let s = sol_in as u128;
    let k = x.checked_mul(y).ok_or(PingyError::AmountOverflow)?;
    let next_x = x.checked_add(s).ok_or(PingyError::AmountOverflow)?;
    let next_y = k.checked_div(next_x).ok_or(PingyError::AmountOverflow)?;
    let tokens_out = y
        .checked_sub(next_y)
        .ok_or(PingyError::AccountingUnderflow)?;

    u64::try_from(tokens_out).map_err(|_| error!(PingyError::AmountOverflow))
}

fn curve_sell_sol(token_in: u64, curve: &Curve) -> Result<u64> {
    if token_in == 0 {
        return Ok(0);
    }

    require!(
        curve.virtual_sol_reserve > 0,
        PingyError::InvalidCurveReserves
    );
    require!(
        curve.virtual_token_reserve > 0,
        PingyError::InvalidCurveReserves
    );

    let x = curve.virtual_sol_reserve as u128;
    let y = curve.virtual_token_reserve as u128;
    let t = token_in as u128;
    let k = x.checked_mul(y).ok_or(PingyError::AmountOverflow)?;
    let next_y = y.checked_add(t).ok_or(PingyError::AmountOverflow)?;
    let next_x = k.checked_div(next_y).ok_or(PingyError::AmountOverflow)?;
    let sol_out = x
        .checked_sub(next_x)
        .ok_or(PingyError::AccountingUnderflow)?;

    u64::try_from(sol_out).map_err(|_| error!(PingyError::AmountOverflow))
}

fn apply_curve_buy(sol_in: u64, curve: &mut Curve) -> Result<u64> {
    let tokens_out = curve_buy_tokens(sol_in, curve)?;

    curve.virtual_sol_reserve = curve
        .virtual_sol_reserve
        .checked_add(sol_in)
        .ok_or(PingyError::AmountOverflow)?;
    curve.virtual_token_reserve = curve
        .virtual_token_reserve
        .checked_sub(tokens_out)
        .ok_or(PingyError::AccountingUnderflow)?;
    curve.real_sol_reserve = curve
        .real_sol_reserve
        .checked_add(sol_in)
        .ok_or(PingyError::AmountOverflow)?;
    curve.real_token_reserve = curve
        .real_token_reserve
        .checked_sub(tokens_out)
        .ok_or(PingyError::AccountingUnderflow)?;

    Ok(tokens_out)
}

fn apply_curve_sell(token_in: u64, curve: &mut Curve) -> Result<u64> {
    let sol_out = curve_sell_sol(token_in, curve)?;

    curve.virtual_sol_reserve = curve
        .virtual_sol_reserve
        .checked_sub(sol_out)
        .ok_or(PingyError::AccountingUnderflow)?;
    curve.virtual_token_reserve = curve
        .virtual_token_reserve
        .checked_add(token_in)
        .ok_or(PingyError::AmountOverflow)?;
    curve.real_sol_reserve = curve
        .real_sol_reserve
        .checked_sub(sol_out)
        .ok_or(PingyError::AccountingUnderflow)?;
    curve.real_token_reserve = curve
        .real_token_reserve
        .checked_add(token_in)
        .ok_or(PingyError::AmountOverflow)?;

    Ok(sol_out)
}

fn maybe_graduate_curve(curve: &mut Curve) -> bool {
    if curve.state == CurveLifecycle::Bonding
        && curve.real_sol_reserve >= curve.graduation_target_lamports
    {
        curve.state = CurveLifecycle::Bonded;
        return true;
    }

    false
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

fn transfer_from_program_owned_account_to_account<'info>(
    source_info: &AccountInfo<'info>,
    recipient_account: &AccountInfo<'info>,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }

    let min_balance = Rent::get()?.minimum_balance(source_info.data_len());
    let available = source_info.lamports().saturating_sub(min_balance);
    require!(
        available >= amount,
        PingyError::InsufficientSpawnPoolBalance
    );

    **source_info.try_borrow_mut_lamports()? = source_info
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
pub struct InitializeThreadCore<'info> {
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
        space = 8 + Curve::LEN,
        seeds = [b"curve", thread_id.as_bytes()],
        bump
    )]
    pub curve: Account<'info, Curve>,
    #[account(
        seeds = [b"curve_authority", thread_id.as_bytes()],
        bump
    )]
    /// CHECK: PDA used as mint authority and token vault authority.
    pub curve_authority: UncheckedAccount<'info>,
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
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(thread_id: String)]
pub struct InitializeThreadAssets<'info> {
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
        seeds = [b"curve", thread_id.as_bytes()],
        bump
    )]
    pub curve: Account<'info, Curve>,
    #[account(
        seeds = [b"curve_authority", thread_id.as_bytes()],
        bump
    )]
    /// CHECK: PDA used as mint authority and token vault authority.
    pub curve_authority: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = admin,
        seeds = [b"mint", thread_id.as_bytes()],
        bump,
        mint::decimals = TOKEN_DECIMALS,
        mint::authority = curve_authority,
        mint::freeze_authority = curve_authority
    )]
    pub mint: Account<'info, Mint>,
    #[account(
        init_if_needed,
        payer = admin,
        seeds = [b"curve_token_vault", thread_id.as_bytes()],
        bump,
        token::mint = mint,
        token::authority = curve_authority
    )]
    pub curve_token_vault: Account<'info, TokenAccount>,
    #[account(
        init_if_needed,
        payer = admin,
        space = 8 + FeeVault::SIZE,
        seeds = [b"fee_vault"],
        bump
    )]
    pub fee_vault: Account<'info, FeeVault>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
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
        seeds = [b"curve", thread_id.as_bytes()],
        bump,
        constraint = curve.thread_id == thread_id @ PingyError::ThreadMismatch
    )]
    pub curve: Account<'info, Curve>,
    #[account(
        seeds = [b"curve_authority", thread_id.as_bytes()],
        bump = curve.curve_authority_bump
    )]
    /// CHECK: PDA used as mint authority and token vault authority.
    pub curve_authority: UncheckedAccount<'info>,
    #[account(mut, address = curve.mint)]
    pub mint: Account<'info, Mint>,
    #[account(
        mut,
        seeds = [b"curve_token_vault", thread_id.as_bytes()],
        bump,
        address = curve.curve_token_vault,
        token::mint = mint,
        token::authority = curve_authority
    )]
    pub curve_token_vault: Account<'info, TokenAccount>,
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
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(thread_id: String)]
pub struct ClaimSpawnTokens<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        seeds = [b"thread", thread_id.as_bytes()],
        bump
    )]
    pub thread: Account<'info, Thread>,
    #[account(
        seeds = [b"curve", thread_id.as_bytes()],
        bump,
        constraint = curve.thread_id == thread_id @ PingyError::ThreadMismatch
    )]
    pub curve: Account<'info, Curve>,
    #[account(
        mut,
        seeds = [b"deposit", thread_id.as_bytes(), user.key().as_ref()],
        bump
    )]
    pub deposit: Account<'info, Deposit>,
    #[account(
        seeds = [b"curve_authority", thread_id.as_bytes()],
        bump = curve.curve_authority_bump
    )]
    /// CHECK: PDA used as mint authority and token vault authority.
    pub curve_authority: UncheckedAccount<'info>,
    #[account(address = curve.mint)]
    pub mint: Account<'info, Mint>,
    #[account(
        mut,
        seeds = [b"curve_token_vault", thread_id.as_bytes()],
        bump,
        address = curve.curve_token_vault,
        token::mint = mint,
        token::authority = curve_authority
    )]
    pub curve_token_vault: Account<'info, TokenAccount>,
    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = mint,
        associated_token::authority = user
    )]
    pub user_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(thread_id: String)]
pub struct Buy<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        seeds = [b"thread", thread_id.as_bytes()],
        bump
    )]
    pub thread: Account<'info, Thread>,
    #[account(
        mut,
        seeds = [b"curve", thread_id.as_bytes()],
        bump,
        constraint = curve.thread_id == thread_id @ PingyError::ThreadMismatch
    )]
    pub curve: Account<'info, Curve>,
    #[account(
        seeds = [b"curve_authority", thread_id.as_bytes()],
        bump = curve.curve_authority_bump
    )]
    /// CHECK: PDA used as token vault authority.
    pub curve_authority: UncheckedAccount<'info>,
    #[account(mut, address = curve.mint)]
    pub mint: Account<'info, Mint>,
    #[account(
        mut,
        seeds = [b"curve_token_vault", thread_id.as_bytes()],
        bump,
        address = curve.curve_token_vault,
        token::mint = mint,
        token::authority = curve_authority
    )]
    pub curve_token_vault: Account<'info, TokenAccount>,
    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = mint,
        associated_token::authority = user
    )]
    pub user_token_account: Account<'info, TokenAccount>,
    #[account(
        mut,
        seeds = [b"spawn_pool", thread_id.as_bytes()],
        bump,
        constraint = spawn_pool.thread_id == thread_id @ PingyError::ThreadMismatch
    )]
    pub spawn_pool: Account<'info, SpawnPool>,
    #[account(
        mut,
        seeds = [b"fee_vault"],
        bump
    )]
    pub fee_vault: Account<'info, FeeVault>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(thread_id: String)]
pub struct Sell<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        seeds = [b"thread", thread_id.as_bytes()],
        bump
    )]
    pub thread: Account<'info, Thread>,
    #[account(
        mut,
        seeds = [b"curve", thread_id.as_bytes()],
        bump,
        constraint = curve.thread_id == thread_id @ PingyError::ThreadMismatch
    )]
    pub curve: Account<'info, Curve>,
    #[account(
        seeds = [b"curve_authority", thread_id.as_bytes()],
        bump = curve.curve_authority_bump
    )]
    /// CHECK: PDA used as token vault authority.
    pub curve_authority: UncheckedAccount<'info>,
    #[account(mut, address = curve.mint)]
    pub mint: Account<'info, Mint>,
    #[account(
        mut,
        seeds = [b"curve_token_vault", thread_id.as_bytes()],
        bump,
        address = curve.curve_token_vault,
        token::mint = mint,
        token::authority = curve_authority
    )]
    pub curve_token_vault: Account<'info, TokenAccount>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = user
    )]
    pub user_token_account: Account<'info, TokenAccount>,
    #[account(
        mut,
        seeds = [b"spawn_pool", thread_id.as_bytes()],
        bump,
        constraint = spawn_pool.thread_id == thread_id @ PingyError::ThreadMismatch
    )]
    pub spawn_pool: Account<'info, SpawnPool>,
    #[account(
        mut,
        seeds = [b"fee_vault"],
        bump
    )]
    pub fee_vault: Account<'info, FeeVault>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[account]
pub struct Thread {
    pub thread_id: String,
    pub admin_pubkey: Pubkey,
    pub spawn_state: SpawnState,
    pub curve_initialized: bool,
    pub launch_mode: u8,
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
    pub const LEN: usize = 4 + Self::MAX_THREAD_ID_LEN + 32 + 1 + 1 + 1 + 4 + 4 + 8 + 8 + 4 + 8 + 2;

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
    pub spawn_token_allocation: u64,
    pub spawn_tokens_claimed: u64,
}

impl Deposit {
    pub const MAX_THREAD_ID_LEN: usize = 64;
    pub const SIZE: usize = 4 + Self::MAX_THREAD_ID_LEN + 32 + 1 + 1 + 8 + 8 + 8 + 8;
    pub const LEN: usize = Self::SIZE;
}

#[account]
pub struct Curve {
    pub thread_id: String,
    pub state: CurveLifecycle,
    pub mint: Pubkey,
    pub mint_decimals: u8,
    pub curve_token_vault: Pubkey,
    pub curve_authority_bump: u8,
    pub total_supply: u64,
    pub virtual_sol_reserve: u64,
    pub virtual_token_reserve: u64,
    pub real_sol_reserve: u64,
    pub real_token_reserve: u64,
    pub opening_buy_lamports: u64,
    pub opening_buy_tokens: u64,
    pub trade_fee_bps: u16,
    pub graduation_target_lamports: u64,
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

impl Curve {
    pub const MAX_THREAD_ID_LEN: usize = 64;
    pub const LEN: usize =
        4 + Self::MAX_THREAD_ID_LEN + 1 + 32 + 1 + 32 + 1 + 8 + 8 + 8 + 8 + 8 + 8 + 8 + 2 + 8;
}

#[event]
pub struct SpawnExecuted {
    pub thread_id: String,
    pub total_to_use: u64,
    pub fee: u64,
    pub net: u64,
    pub opening_buy_tokens: u64,
}

#[event]
pub struct BuyExecuted {
    pub thread_id: String,
    pub user: Pubkey,
    pub gross_sol: u64,
    pub fee_sol: u64,
    pub net_sol: u64,
    pub tokens_out: u64,
}

#[event]
pub struct SellExecuted {
    pub thread_id: String,
    pub user: Pubkey,
    pub tokens_in: u64,
    pub gross_sol_out: u64,
    pub fee_sol: u64,
    pub net_sol_out: u64,
}

#[event]
pub struct CurveGraduated {
    pub thread_id: String,
    pub final_sol_reserve: u64,
    pub final_token_reserve: u64,
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

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum CurveLifecycle {
    PreSpawn,
    Bonding,
    Bonded,
}

#[error_code]
pub enum PingyError {
    #[msg("Invalid thread id")]
    InvalidThreadId,
    #[msg("Invalid amount")]
    InvalidAmount,
    #[msg("Ping amount is too small after setup costs")]
    PingAmountTooSmall,
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
    #[msg("Curve reserves are invalid")]
    InvalidCurveReserves,
    #[msg("Curve mint authority is invalid")]
    InvalidCurveMintAuthority,
    #[msg("Curve token vault mint does not match curve mint")]
    CurveTokenVaultMintMismatch,
    #[msg("Missing approved deposit accounts required for spawn allocation")]
    MissingApprovedDepositAccounts,
    #[msg("Invalid remaining account passed for deposit allocation")]
    InvalidDepositRemainingAccount,
    #[msg("Nothing to claim")]
    NothingToClaim,
    #[msg("Spawn is not closed")]
    SpawnNotClosed,
    #[msg("Curve state does not allow this operation")]
    InvalidCurveState,
    #[msg("Spawn pool has insufficient available lamports")]
    InsufficientSpawnPoolBalance,
    #[msg("User token account is invalid")]
    InvalidUserTokenAccount,
    #[msg("Launch mode is invalid")]
    InvalidLaunchMode,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn curve_fixture() -> Curve {
        Curve {
            thread_id: "thread".to_string(),
            state: CurveLifecycle::PreSpawn,
            mint: Pubkey::default(),
            mint_decimals: TOKEN_DECIMALS,
            curve_token_vault: Pubkey::default(),
            curve_authority_bump: 0,
            total_supply: TOTAL_SUPPLY,
            virtual_sol_reserve: VIRTUAL_SOL_RESERVE_INITIAL,
            virtual_token_reserve: VIRTUAL_TOKEN_RESERVE_INITIAL,
            real_sol_reserve: 0,
            real_token_reserve: TOTAL_SUPPLY,
            opening_buy_lamports: 0,
            opening_buy_tokens: 0,
            trade_fee_bps: POST_SPAWN_TRADING_FEE_BPS,
            graduation_target_lamports: GRADUATION_TARGET_LAMPORTS,
        }
    }

    #[test]
    fn trade_fee_output_is_correct() {
        let amount = 1_000_000_000u64;
        let (net, fee) = apply_trade_fee(amount, POST_SPAWN_TRADING_FEE_BPS).unwrap();
        assert_eq!(fee, 10_000_000);
        assert_eq!(net, 990_000_000);
    }

    #[test]
    fn apply_curve_buy_updates_reserves() {
        let mut curve = curve_fixture();
        let sol_in = LAMPORTS_PER_SOL;

        let tokens_out = apply_curve_buy(sol_in, &mut curve).unwrap();

        assert!(tokens_out > 0);
        assert_eq!(
            curve.virtual_sol_reserve,
            VIRTUAL_SOL_RESERVE_INITIAL + sol_in
        );
        assert!(curve.virtual_token_reserve < VIRTUAL_TOKEN_RESERVE_INITIAL);
        assert_eq!(curve.real_sol_reserve, sol_in);
        assert_eq!(curve.real_token_reserve, TOTAL_SUPPLY - tokens_out);
    }

    #[test]
    fn apply_curve_sell_updates_reserves() {
        let mut curve = curve_fixture();
        let sol_in = LAMPORTS_PER_SOL;
        let tokens_out = apply_curve_buy(sol_in, &mut curve).unwrap();

        let sol_out = apply_curve_sell(tokens_out / 2, &mut curve).unwrap();

        assert!(sol_out > 0);
        assert!(curve.virtual_sol_reserve < VIRTUAL_SOL_RESERVE_INITIAL + sol_in);
        assert!(curve.virtual_token_reserve > VIRTUAL_TOKEN_RESERVE_INITIAL - tokens_out);
    }

    #[test]
    fn sell_fails_when_real_sol_reserve_is_insufficient() {
        let mut curve = curve_fixture();
        let sol_in = LAMPORTS_PER_SOL;
        let tokens_out = apply_curve_buy(sol_in, &mut curve).unwrap();
        curve.real_sol_reserve = 0;

        let result = apply_curve_sell(tokens_out, &mut curve);
        assert!(result.is_err());
    }

    #[test]
    fn curve_math_is_monotonic_and_deterministic() {
        let sol_in = 250_000_000u64;
        let mut curve_a = curve_fixture();
        let mut curve_b = curve_fixture();

        let out_a = apply_curve_buy(sol_in, &mut curve_a).unwrap();
        let out_b = apply_curve_buy(sol_in, &mut curve_b).unwrap();
        assert_eq!(out_a, out_b);

        let out_more = curve_buy_tokens(sol_in * 2, &curve_fixture()).unwrap();
        assert!(out_more >= out_a);

        let mut curve_sell_a = curve_fixture();
        apply_curve_buy(sol_in, &mut curve_sell_a).unwrap();
        let sell_a = curve_sell_sol(10_000_000, &curve_sell_a).unwrap();
        let sell_b = curve_sell_sol(20_000_000, &curve_sell_a).unwrap();
        assert!(sell_b >= sell_a);
    }

    #[test]
    fn initialize_curve_state_sets_expected_defaults() {
        let mut curve = curve_fixture();
        curve.state = CurveLifecycle::Bonding;
        curve.virtual_sol_reserve = 1;
        curve.real_sol_reserve = 7;

        initialize_curve_state(
            &mut curve,
            TOTAL_SUPPLY,
            POST_SPAWN_TRADING_FEE_BPS,
            GRADUATION_TARGET_LAMPORTS,
        );

        assert!(matches!(curve.state, CurveLifecycle::PreSpawn));
        assert_eq!(curve.mint, Pubkey::default());
        assert_eq!(curve.mint_decimals, TOKEN_DECIMALS);
        assert_eq!(curve.curve_token_vault, Pubkey::default());
        assert_eq!(curve.curve_authority_bump, 0);
        assert_eq!(curve.total_supply, TOTAL_SUPPLY);
        assert_eq!(curve.virtual_sol_reserve, VIRTUAL_SOL_RESERVE_INITIAL);
        assert_eq!(curve.virtual_token_reserve, VIRTUAL_TOKEN_RESERVE_INITIAL);
        assert_eq!(curve.real_sol_reserve, 0);
        assert_eq!(curve.real_token_reserve, TOTAL_SUPPLY);
        assert_eq!(curve.opening_buy_lamports, 0);
        assert_eq!(curve.opening_buy_tokens, 0);
        assert_eq!(curve.trade_fee_bps, POST_SPAWN_TRADING_FEE_BPS);
        assert_eq!(curve.graduation_target_lamports, GRADUATION_TARGET_LAMPORTS);
    }
}
