use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hashv;
use anchor_lang::system_program;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount, Transfer};

declare_id!("GqZPaDR3Mx3eL75VGeRErRGiDB8cDRtwa66dYRQCt5fY");

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
pub const V2_ACCOUNT_VERSION: u8 = 1;
pub const V2_LAUNCH_BACKEND_NATIVE: u8 = 0;
pub const V2_LAUNCH_BACKEND_EXTERNAL: u8 = 1;

fn room_seed_bytes(thread_id: &str) -> [u8; 32] {
    hashv(&[thread_id.as_bytes()]).to_bytes()
}

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
                b"curve_authority",
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
        require!(
            net_contribution_lamports > 0,
            PingyError::PingAmountTooSmall
        );

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
            b"curve_authority",
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

        let room_seed = room_seed_bytes(&thread_id);
        let signer_seeds: &[&[&[u8]]] = &[&[
            b"curve_authority",
            room_seed.as_ref(),
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

        let room_seed = room_seed_bytes(&thread_id);
        let signer_seeds: &[&[&[u8]]] = &[&[
            b"curve_authority",
            room_seed.as_ref(),
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

    pub fn initialize_v2_global_state(
        ctx: Context<InitializeV2GlobalState>,
        default_ping_fee_recipient: Pubkey,
    ) -> Result<()> {
        let program_state = &mut ctx.accounts.program_state;
        program_state.version = V2_ACCOUNT_VERSION;
        program_state.admin_pubkey = ctx.accounts.admin.key();
        program_state.shared_vault = ctx.accounts.shared_vault.key();
        program_state.fee_vault = ctx.accounts.fee_vault.key();
        program_state.default_ping_fee_recipient = default_ping_fee_recipient;
        program_state.bump = ctx.bumps.program_state;

        let shared_vault = &mut ctx.accounts.shared_vault;
        shared_vault.version = V2_ACCOUNT_VERSION;
        shared_vault.bump = ctx.bumps.shared_vault;
        shared_vault.total_reserved_lamports = 0;

        let fee_vault = &mut ctx.accounts.fee_vault;
        fee_vault.version = V2_ACCOUNT_VERSION;
        fee_vault.bump = ctx.bumps.fee_vault;
        fee_vault.spawn_fee_lamports_accrued = 0;
        fee_vault.trade_fee_lamports_accrued = 0;

        Ok(())
    }

    pub fn create_room_ledger(
        ctx: Context<CreateRoomLedger>,
        room_id: String,
        launch_backend: u8,
        launch_mode: u8,
        min_approved_wallets: u32,
        spawn_target_lamports: u64,
        max_wallet_share_bps: u16,
    ) -> Result<()> {
        require!(!room_id.is_empty(), PingyError::InvalidThreadId);
        require!(
            launch_backend == V2_LAUNCH_BACKEND_NATIVE
                || launch_backend == V2_LAUNCH_BACKEND_EXTERNAL,
            PingyError::InvalidLaunchBackend
        );
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

        let room_ledger = &mut ctx.accounts.room_ledger;
        room_ledger.version = V2_ACCOUNT_VERSION;
        room_ledger.bump = ctx.bumps.room_ledger;
        room_ledger.room_id = room_id.clone();
        room_ledger.creator_pubkey = ctx.accounts.admin.key();
        room_ledger.admin_pubkey = ctx.accounts.admin.key();
        room_ledger.launch_backend = launch_backend;
        room_ledger.launch_mode = launch_mode;
        room_ledger.state = V2RoomState::Open;
        room_ledger.min_approved_wallets = min_approved_wallets;
        room_ledger.spawn_target_lamports = spawn_target_lamports;
        room_ledger.max_wallet_share_bps = max_wallet_share_bps;
        room_ledger.pending_count = 0;
        room_ledger.approved_count = 0;
        room_ledger.total_bundle_lamports = 0;
        room_ledger.total_refundable_lamports = 0;
        room_ledger.total_allocated_lamports = 0;
        room_ledger.total_forwarded_lamports = 0;
        room_ledger.total_refunded_lamports = 0;
        room_ledger.spawn_finalized = false;
        room_ledger.mint = Pubkey::default();
        room_ledger.curve = Pubkey::default();
        room_ledger.spawn_pool = Pubkey::default();
        room_ledger.curve_token_vault = Pubkey::default();
        room_ledger.external_settlement_mode = 0;
        room_ledger.external_settlement_status = V2ExternalSettlementStatus::Pending;
        room_ledger.total_external_units_settled = 0;
        validate_room_ledger_accounting(room_ledger)?;

        Ok(())
    }

    pub fn ping_deposit_shared(
        ctx: Context<PingDepositShared>,
        room_id: String,
        amount_lamports: u64,
    ) -> Result<()> {
        require!(amount_lamports > 0, PingyError::InvalidAmount);

        let room_ledger = &mut ctx.accounts.room_ledger;
        require!(
            room_ledger.room_id == room_id,
            PingyError::RoomLedgerMismatch
        );
        require!(
            room_ledger.state == V2RoomState::Open && !room_ledger.spawn_finalized,
            PingyError::V2RoomNotOpen
        );
        let room_receipt = &mut ctx.accounts.room_receipt;
        let is_new_receipt = room_receipt.version != V2_ACCOUNT_VERSION;
        let mut receipt_rent_lamports: u64 = 0;
        if is_new_receipt {
            receipt_rent_lamports = room_receipt.to_account_info().lamports();
            room_receipt.version = V2_ACCOUNT_VERSION;
            room_receipt.bump = ctx.bumps.room_receipt;
            room_receipt.room_id = room_id.clone();
            room_receipt.user_pubkey = ctx.accounts.user.key();
            room_receipt.status = if ctx.accounts.user.key() == room_ledger.creator_pubkey {
                V2ReceiptStatus::Approved
            } else {
                V2ReceiptStatus::Pending
            };
            room_receipt.bundle_lamports_total = 0;
            room_receipt.refundable_lamports = 0;
            room_receipt.allocated_lamports = 0;
            room_receipt.forwarded_lamports = 0;
            room_receipt.refunded_lamports = 0;
            room_receipt.receipt_backing_lamports = 0;
            room_receipt.native_token_allocation = 0;
            room_receipt.native_tokens_claimed = 0;
            room_receipt.external_allocation_units = 0;
            room_receipt.external_units_claimed = 0;
            room_ledger.increment_v2_status_count(room_receipt.status)?;
        } else {
            require!(room_receipt.room_id == room_id, PingyError::ReceiptMismatch);
            require!(
                room_receipt.user_pubkey == ctx.accounts.user.key(),
                PingyError::UserMismatch
            );
        }
        let is_first_receipt_deposit = room_receipt.bundle_lamports_total == 0
            && room_receipt.refundable_lamports == 0
            && room_receipt.allocated_lamports == 0
            && room_receipt.forwarded_lamports == 0
            && room_receipt.refunded_lamports == 0
            && room_receipt.receipt_backing_lamports == 0;
        let receipt_backing_lamports = if is_first_receipt_deposit {
            amount_lamports.min(Rent::get()?.minimum_balance(8 + RoomReceipt::LEN) as u64)
        } else {
            0
        };
        let escrow_contribution_lamports = amount_lamports
            .checked_sub(receipt_backing_lamports)
            .ok_or(PingyError::AccountingUnderflow)?;

        let transfer_ctx = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.user.to_account_info(),
                to: ctx.accounts.shared_vault.to_account_info(),
            },
        );
        system_program::transfer(transfer_ctx, amount_lamports)?;
        if is_new_receipt {
            if receipt_rent_lamports > 0 {
                transfer_from_program_owned_account_to_account(
                    &ctx.accounts.shared_vault.to_account_info(),
                    &ctx.accounts.user.to_account_info(),
                    receipt_rent_lamports,
                )?;
            }
        }

        {
            let shared_vault = &mut ctx.accounts.shared_vault;
            shared_vault.total_reserved_lamports = shared_vault
                .total_reserved_lamports
                .checked_add(amount_lamports)
                .ok_or(PingyError::AmountOverflow)?;
            if is_new_receipt && receipt_rent_lamports > 0 {
                shared_vault.total_reserved_lamports = shared_vault
                    .total_reserved_lamports
                    .checked_sub(receipt_rent_lamports)
                    .ok_or(PingyError::AccountingUnderflow)?;
            }
        }

        let previous_status;
        {
            previous_status = room_receipt.status;
            room_receipt.bundle_lamports_total = room_receipt
                .bundle_lamports_total
                .checked_add(amount_lamports)
                .ok_or(PingyError::AmountOverflow)?;
            room_receipt.receipt_backing_lamports = room_receipt
                .receipt_backing_lamports
                .checked_add(receipt_backing_lamports)
                .ok_or(PingyError::AmountOverflow)?;
            room_receipt.refundable_lamports = room_receipt
                .refundable_lamports
                .checked_add(escrow_contribution_lamports)
                .ok_or(PingyError::AmountOverflow)?;
            room_ledger.total_bundle_lamports = room_ledger
                .total_bundle_lamports
                .checked_add(amount_lamports)
                .ok_or(PingyError::AmountOverflow)?;
            room_ledger.total_refundable_lamports = room_ledger
                .total_refundable_lamports
                .checked_add(escrow_contribution_lamports)
                .ok_or(PingyError::AmountOverflow)?;

            if room_receipt.status == V2ReceiptStatus::Approved {
                allocate_for_room_receipt(room_ledger, room_receipt)?;
            }
        }

        if !is_new_receipt {
            room_ledger
                .apply_v2_status_transition(previous_status, ctx.accounts.room_receipt.status)?;
        }

        validate_room_receipt_accounting(&ctx.accounts.room_receipt)?;
        validate_room_ledger_accounting(room_ledger)?;

        Ok(())
    }

    pub fn create_room_receipt_for_user(
        ctx: Context<CreateRoomReceiptForUser>,
        room_id: String,
    ) -> Result<()> {
        let room_ledger = &mut ctx.accounts.room_ledger;
        require!(
            room_ledger.room_id == room_id,
            PingyError::RoomLedgerMismatch
        );
        require!(
            room_ledger.state == V2RoomState::Open && !room_ledger.spawn_finalized,
            PingyError::V2RoomNotOpen
        );

        let room_receipt = &mut ctx.accounts.room_receipt;
        room_receipt.version = V2_ACCOUNT_VERSION;
        room_receipt.bump = ctx.bumps.room_receipt;
        room_receipt.room_id = room_id.clone();
        room_receipt.user_pubkey = ctx.accounts.user.key();
        room_receipt.status = if ctx.accounts.user.key() == room_ledger.creator_pubkey {
            V2ReceiptStatus::Approved
        } else {
            V2ReceiptStatus::Pending
        };
        room_receipt.bundle_lamports_total = 0;
        room_receipt.refundable_lamports = 0;
        room_receipt.allocated_lamports = 0;
        room_receipt.forwarded_lamports = 0;
        room_receipt.refunded_lamports = 0;
        room_receipt.receipt_backing_lamports = 0;
        room_receipt.native_token_allocation = 0;
        room_receipt.native_tokens_claimed = 0;
        room_receipt.external_allocation_units = 0;
        room_receipt.external_units_claimed = 0;

        room_ledger.increment_v2_status_count(room_receipt.status)?;
        validate_room_receipt_accounting(room_receipt)?;
        validate_room_ledger_accounting(room_ledger)?;

        let receipt_status_label = if room_receipt.status == V2ReceiptStatus::Approved {
            "approved"
        } else {
            "pending"
        };
        msg!(
            "create_room_receipt_for_user room={} user={} receipt={} status={}",
            room_id,
            ctx.accounts.user.key(),
            ctx.accounts.room_receipt.key(),
            receipt_status_label
        );
        Ok(())
    }

    pub fn approve_receipt(
        ctx: Context<ApproveReceipt>,
        room_id: String,
        user_pubkey: Pubkey,
    ) -> Result<()> {
        let room_ledger = &mut ctx.accounts.room_ledger;
        require!(
            room_ledger.room_id == room_id,
            PingyError::RoomLedgerMismatch
        );
        require!(
            room_ledger.state == V2RoomState::Open && !room_ledger.spawn_finalized,
            PingyError::V2RoomNotOpen
        );

        let room_receipt = &mut ctx.accounts.room_receipt;
        require!(
            room_receipt.user_pubkey == user_pubkey,
            PingyError::UserMismatch
        );

        let previous_status = room_receipt.status;
        room_receipt.status = V2ReceiptStatus::Approved;
        allocate_for_room_receipt(room_ledger, room_receipt)?;
        room_ledger.apply_v2_status_transition(previous_status, room_receipt.status)?;

        validate_room_receipt_accounting(room_receipt)?;
        validate_room_ledger_accounting(room_ledger)?;

        Ok(())
    }

    pub fn revoke_receipt(
        ctx: Context<RevokeReceipt>,
        room_id: String,
        user_pubkey: Pubkey,
    ) -> Result<()> {
        let room_ledger = &mut ctx.accounts.room_ledger;
        require!(
            room_ledger.room_id == room_id,
            PingyError::RoomLedgerMismatch
        );
        require!(
            room_ledger.state == V2RoomState::Open && !room_ledger.spawn_finalized,
            PingyError::V2RoomNotOpen
        );

        let room_receipt = &mut ctx.accounts.room_receipt;
        require!(
            room_receipt.user_pubkey == user_pubkey,
            PingyError::UserMismatch
        );
        require!(
            room_receipt.status == V2ReceiptStatus::Approved,
            PingyError::DepositNotApproved
        );

        let allocated_before = room_receipt.allocated_lamports;
        let previous_status = room_receipt.status;
        room_receipt.status = V2ReceiptStatus::Revoked;
        room_receipt.refundable_lamports = room_receipt
            .refundable_lamports
            .checked_add(allocated_before)
            .ok_or(PingyError::AmountOverflow)?;
        room_receipt.allocated_lamports = 0;

        room_ledger.total_allocated_lamports = room_ledger
            .total_allocated_lamports
            .checked_sub(allocated_before)
            .ok_or(PingyError::AccountingUnderflow)?;
        room_ledger.total_refundable_lamports = room_ledger
            .total_refundable_lamports
            .checked_add(allocated_before)
            .ok_or(PingyError::AmountOverflow)?;
        room_ledger.apply_v2_status_transition(previous_status, room_receipt.status)?;

        validate_room_receipt_accounting(room_receipt)?;
        validate_room_ledger_accounting(room_ledger)?;

        Ok(())
    }

    pub fn unping_refund(ctx: Context<UnpingRefund>, room_id: String) -> Result<()> {
        let room_ledger = &mut ctx.accounts.room_ledger;
        require!(
            room_ledger.room_id == room_id,
            PingyError::RoomLedgerMismatch
        );
        require!(
            room_ledger.state == V2RoomState::Open && !room_ledger.spawn_finalized,
            PingyError::V2RoomNotOpen
        );

        let room_receipt = &mut ctx.accounts.room_receipt;
        require!(
            room_receipt.user_pubkey == ctx.accounts.user.key(),
            PingyError::UserMismatch
        );

        let payout = room_receipt
            .refundable_lamports
            .checked_add(room_receipt.allocated_lamports)
            .ok_or(PingyError::AmountOverflow)?;
        let bundled_refund_lamports = payout
            .checked_add(room_receipt.receipt_backing_lamports)
            .ok_or(PingyError::AmountOverflow)?;
        let allocated_before = room_receipt.allocated_lamports;
        let previous_status = room_receipt.status;

        transfer_from_program_owned_account_to_account(
            &ctx.accounts.shared_vault.to_account_info(),
            &ctx.accounts.user.to_account_info(),
            payout,
        )?;

        let shared_vault = &mut ctx.accounts.shared_vault;
        shared_vault.total_reserved_lamports = shared_vault
            .total_reserved_lamports
            .checked_sub(payout)
            .ok_or(PingyError::AccountingUnderflow)?;

        room_ledger.total_bundle_lamports = room_ledger
            .total_bundle_lamports
            .checked_sub(bundled_refund_lamports)
            .ok_or(PingyError::AccountingUnderflow)?;
        room_ledger.total_refundable_lamports = room_ledger
            .total_refundable_lamports
            .checked_sub(room_receipt.refundable_lamports)
            .ok_or(PingyError::AccountingUnderflow)?;
        room_ledger.total_allocated_lamports = room_ledger
            .total_allocated_lamports
            .checked_sub(allocated_before)
            .ok_or(PingyError::AccountingUnderflow)?;
        room_ledger.total_refunded_lamports = room_ledger
            .total_refunded_lamports
            .checked_add(bundled_refund_lamports)
            .ok_or(PingyError::AmountOverflow)?;

        room_receipt.refundable_lamports = 0;
        room_receipt.allocated_lamports = 0;
        room_receipt.refunded_lamports = room_receipt
            .refunded_lamports
            .checked_add(bundled_refund_lamports)
            .ok_or(PingyError::AmountOverflow)?;
        room_receipt.status = V2ReceiptStatus::Withdrawn;
        room_ledger.apply_v2_status_transition(previous_status, room_receipt.status)?;

        validate_room_receipt_accounting(room_receipt)?;
        validate_room_ledger_accounting(room_ledger)?;

        Ok(())
    }

    pub fn execute_spawn_native<'info>(
        ctx: Context<'_, '_, 'info, 'info, ExecuteSpawnNative<'info>>,
        room_id: String,
    ) -> Result<()> {
        let room_ledger = &mut ctx.accounts.room_ledger;
        require!(
            room_ledger.room_id == room_id,
            PingyError::RoomLedgerMismatch
        );
        require!(
            room_ledger.launch_backend == V2_LAUNCH_BACKEND_NATIVE,
            PingyError::InvalidLaunchBackendForRoom
        );
        require!(
            room_ledger.state == V2RoomState::Open && !room_ledger.spawn_finalized,
            PingyError::V2RoomNotOpen
        );
        require!(
            room_ledger.total_allocated_lamports >= room_ledger.spawn_target_lamports,
            PingyError::SpawnTargetNotReached
        );
        require!(
            room_ledger.approved_count >= room_ledger.min_approved_wallets,
            PingyError::MinApprovedWalletsNotReached
        );

        // V2 forwards exactly the configured spawn target on spawn execution. Any approved
        // value above the target remains in-room and is not swept by this instruction.
        let exact_target_forward_lamports = room_ledger.spawn_target_lamports;
        let fee = exact_target_forward_lamports
            .checked_mul(SPAWN_FEE_BPS)
            .ok_or(PingyError::AmountOverflow)?
            .checked_div(BPS_DENOM)
            .ok_or(PingyError::AmountOverflow)?;
        let net = exact_target_forward_lamports
            .checked_sub(fee)
            .ok_or(PingyError::AccountingUnderflow)?;

        let curve = &mut ctx.accounts.curve;
        curve.thread_id = room_id.clone();
        initialize_curve_state(
            curve,
            TOTAL_SUPPLY,
            POST_SPAWN_TRADING_FEE_BPS,
            GRADUATION_TARGET_LAMPORTS,
        );
        curve.curve_authority_bump = ctx.bumps.curve_authority;
        initialize_mint_if_needed(curve, &ctx.accounts.mint, &ctx.accounts.curve_authority)?;
        initialize_curve_token_vault_if_needed(
            curve,
            &ctx.accounts.curve_token_vault,
            &ctx.accounts.curve_authority,
        )?;

        let spawn_pool = &mut ctx.accounts.spawn_pool;
        spawn_pool.thread_id = room_id.clone();

        mint_total_supply_to_curve_vault(
            b"v2_curve_authority",
            &room_id,
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
            tokens_out
        };

        allocate_v2_spawn_tokens_pro_rata(
            room_ledger,
            &room_id,
            exact_target_forward_lamports,
            tokens_out,
            ctx.remaining_accounts,
        )?;

        transfer_from_program_owned_account_to_account(
            &ctx.accounts.shared_vault.to_account_info(),
            &ctx.accounts.fee_vault.to_account_info(),
            fee,
        )?;
        transfer_from_program_owned_account_to_account(
            &ctx.accounts.shared_vault.to_account_info(),
            &ctx.accounts.spawn_pool.to_account_info(),
            net,
        )?;

        ctx.accounts.shared_vault.total_reserved_lamports = ctx
            .accounts
            .shared_vault
            .total_reserved_lamports
            .checked_sub(exact_target_forward_lamports)
            .ok_or(PingyError::AccountingUnderflow)?;
        ctx.accounts.fee_vault.spawn_fee_lamports_accrued = ctx
            .accounts
            .fee_vault
            .spawn_fee_lamports_accrued
            .checked_add(fee)
            .ok_or(PingyError::AmountOverflow)?;

        room_ledger.total_allocated_lamports = room_ledger
            .total_allocated_lamports
            .checked_sub(exact_target_forward_lamports)
            .ok_or(PingyError::AccountingUnderflow)?;
        room_ledger.total_forwarded_lamports = room_ledger
            .total_forwarded_lamports
            .checked_add(exact_target_forward_lamports)
            .ok_or(PingyError::AmountOverflow)?;
        room_ledger.spawn_finalized = true;
        room_ledger.state = V2RoomState::NativeBonding;
        room_ledger.curve = ctx.accounts.curve.key();
        room_ledger.mint = ctx.accounts.mint.key();
        room_ledger.spawn_pool = ctx.accounts.spawn_pool.key();
        room_ledger.curve_token_vault = ctx.accounts.curve_token_vault.key();

        validate_room_ledger_accounting(room_ledger)?;

        Ok(())
    }

    pub fn execute_spawn_external<'info>(
        ctx: Context<'_, '_, 'info, 'info, ExecuteSpawnExternal<'info>>,
        room_id: String,
    ) -> Result<()> {
        let room_ledger = &mut ctx.accounts.room_ledger;
        require!(
            room_ledger.room_id == room_id,
            PingyError::RoomLedgerMismatch
        );
        require!(
            room_ledger.launch_backend == V2_LAUNCH_BACKEND_EXTERNAL,
            PingyError::InvalidLaunchBackendForRoom
        );
        require!(
            room_ledger.state == V2RoomState::Open && !room_ledger.spawn_finalized,
            PingyError::V2RoomNotOpen
        );
        require!(
            room_ledger.total_allocated_lamports >= room_ledger.spawn_target_lamports,
            PingyError::SpawnTargetNotReached
        );
        require!(
            room_ledger.approved_count >= room_ledger.min_approved_wallets,
            PingyError::MinApprovedWalletsNotReached
        );

        // V2 external spawn is an accounting freeze only: it marks exactly the configured
        // spawn target as no longer refundable on chain and creates each receipt's external
        // entitlement basis. The actual external payout/launch happens off-chain later.
        let exact_target_forward_lamports = room_ledger.spawn_target_lamports;
        allocate_v2_external_units(
            room_ledger,
            &room_id,
            exact_target_forward_lamports,
            ctx.remaining_accounts,
        )?;

        ctx.accounts.shared_vault.total_reserved_lamports = ctx
            .accounts
            .shared_vault
            .total_reserved_lamports
            .checked_sub(exact_target_forward_lamports)
            .ok_or(PingyError::AccountingUnderflow)?;
        room_ledger.total_allocated_lamports = room_ledger
            .total_allocated_lamports
            .checked_sub(exact_target_forward_lamports)
            .ok_or(PingyError::AccountingUnderflow)?;
        room_ledger.total_forwarded_lamports = room_ledger
            .total_forwarded_lamports
            .checked_add(exact_target_forward_lamports)
            .ok_or(PingyError::AmountOverflow)?;
        room_ledger.spawn_finalized = true;
        room_ledger.state = V2RoomState::ExternalFinalized;
        room_ledger.external_settlement_status = V2ExternalSettlementStatus::Pending;

        validate_room_ledger_accounting(room_ledger)?;

        Ok(())
    }

    pub fn claim_spawn_tokens_v2(ctx: Context<ClaimSpawnTokensV2>, room_id: String) -> Result<()> {
        require!(
            ctx.accounts.room_ledger.room_id == room_id,
            PingyError::RoomLedgerMismatch
        );
        require!(
            ctx.accounts.room_ledger.launch_backend == V2_LAUNCH_BACKEND_NATIVE,
            PingyError::InvalidLaunchBackendForRoom
        );
        require!(
            ctx.accounts.room_ledger.state == V2RoomState::NativeBonding
                || ctx.accounts.room_ledger.state == V2RoomState::NativeBonded,
            PingyError::V2RoomNotSpawned
        );
        require!(
            ctx.accounts.room_receipt.room_id == room_id,
            PingyError::ReceiptMismatch
        );
        require!(
            ctx.accounts.room_receipt.user_pubkey == ctx.accounts.user.key(),
            PingyError::UserMismatch
        );

        let claimable = ctx
            .accounts
            .room_receipt
            .native_token_allocation
            .checked_sub(ctx.accounts.room_receipt.native_tokens_claimed)
            .ok_or(PingyError::AccountingUnderflow)?;
        require!(claimable > 0, PingyError::NothingToClaim);

        let room_seed = room_seed_bytes(&room_id);
        let signer_seeds: &[&[&[u8]]] = &[&[
            b"v2_curve_authority",
            room_seed.as_ref(),
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

        ctx.accounts.room_receipt.native_tokens_claimed = ctx
            .accounts
            .room_receipt
            .native_tokens_claimed
            .checked_add(claimable)
            .ok_or(PingyError::AmountOverflow)?;

        validate_room_receipt_accounting(&ctx.accounts.room_receipt)?;
        validate_room_ledger_accounting(&ctx.accounts.room_ledger)?;

        Ok(())
    }

    pub fn record_external_distribution(
        ctx: Context<RecordExternalDistribution>,
        room_id: String,
        settled_external_units: u64,
    ) -> Result<()> {
        require!(settled_external_units > 0, PingyError::InvalidAmount);
        require!(
            ctx.accounts.room_ledger.room_id == room_id,
            PingyError::RoomLedgerMismatch
        );
        require!(
            ctx.accounts.room_ledger.launch_backend == V2_LAUNCH_BACKEND_EXTERNAL,
            PingyError::InvalidLaunchBackendForRoom
        );
        require!(
            ctx.accounts.room_ledger.state == V2RoomState::ExternalFinalized,
            PingyError::V2RoomNotSpawned
        );
        require!(
            ctx.accounts.room_receipt.room_id == room_id,
            PingyError::ReceiptMismatch
        );
        require!(
            ctx.accounts.room_receipt.status == V2ReceiptStatus::Converted,
            PingyError::ExternalSettlementNotReady
        );

        let unsettled_external_units = ctx
            .accounts
            .room_receipt
            .external_allocation_units
            .checked_sub(ctx.accounts.room_receipt.external_units_claimed)
            .ok_or(PingyError::AccountingUnderflow)?;
        require!(
            settled_external_units <= unsettled_external_units,
            PingyError::ExternalDistributionExceedsEntitlement
        );
        ctx.accounts.room_receipt.external_units_claimed = ctx
            .accounts
            .room_receipt
            .external_units_claimed
            .checked_add(settled_external_units)
            .ok_or(PingyError::AmountOverflow)?;
        ctx.accounts.room_ledger.total_external_units_settled = ctx
            .accounts
            .room_ledger
            .total_external_units_settled
            .checked_add(settled_external_units)
            .ok_or(PingyError::AmountOverflow)?;
        sync_room_external_settlement_status(&mut ctx.accounts.room_ledger)?;

        validate_room_receipt_accounting(&ctx.accounts.room_receipt)?;
        validate_room_ledger_accounting(&ctx.accounts.room_ledger)?;

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

fn allocate_for_room_receipt(
    room_ledger: &mut Account<RoomLedger>,
    room_receipt: &mut Account<RoomReceipt>,
) -> Result<()> {
    let remaining_needed = room_ledger
        .spawn_target_lamports
        .saturating_sub(room_ledger.total_allocated_lamports);
    let wallet_cap = room_ledger
        .spawn_target_lamports
        .checked_mul(room_ledger.max_wallet_share_bps as u64)
        .ok_or(PingyError::AmountOverflow)?
        .checked_div(BPS_DENOM)
        .ok_or(PingyError::AmountOverflow)?;
    let wallet_remaining = wallet_cap.saturating_sub(room_receipt.allocated_lamports);
    let movable = room_receipt
        .refundable_lamports
        .min(remaining_needed)
        .min(wallet_remaining);

    if movable == 0 {
        return Ok(());
    }

    room_receipt.refundable_lamports = room_receipt
        .refundable_lamports
        .checked_sub(movable)
        .ok_or(PingyError::AccountingUnderflow)?;
    room_receipt.allocated_lamports = room_receipt
        .allocated_lamports
        .checked_add(movable)
        .ok_or(PingyError::AmountOverflow)?;
    room_ledger.total_refundable_lamports = room_ledger
        .total_refundable_lamports
        .checked_sub(movable)
        .ok_or(PingyError::AccountingUnderflow)?;
    room_ledger.total_allocated_lamports = room_ledger
        .total_allocated_lamports
        .checked_add(movable)
        .ok_or(PingyError::AmountOverflow)?;

    Ok(())
}

fn allocate_v2_spawn_tokens_pro_rata<'info>(
    room_ledger: &mut Account<RoomLedger>,
    room_id: &str,
    use_amt: u64,
    tokens_out: u64,
    remaining_accounts: &'info [AccountInfo<'info>],
) -> Result<()> {
    let mut remaining_lamports = use_amt;
    let mut remaining_tokens = tokens_out;

    for account_info in remaining_accounts.iter() {
        let mut room_receipt: Account<RoomReceipt> = Account::try_from(account_info)?;
        require!(
            room_receipt.room_id == room_id,
            PingyError::InvalidReceiptRemainingAccount
        );
        require!(
            room_receipt.status == V2ReceiptStatus::Approved,
            PingyError::DepositNotApproved
        );

        let allocated = room_receipt.allocated_lamports;
        require!(
            allocated <= remaining_lamports,
            PingyError::InvalidReceiptRemainingAccount
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

        let previous_status = room_receipt.status;
        room_receipt.forwarded_lamports = room_receipt
            .forwarded_lamports
            .checked_add(allocated)
            .ok_or(PingyError::AmountOverflow)?;
        room_receipt.native_token_allocation = room_receipt
            .native_token_allocation
            .checked_add(wallet_tokens)
            .ok_or(PingyError::AmountOverflow)?;
        room_receipt.allocated_lamports = 0;
        room_receipt.status = V2ReceiptStatus::Converted;
        room_ledger.apply_v2_status_transition(previous_status, room_receipt.status)?;
        validate_room_receipt_accounting(&room_receipt)?;

        remaining_lamports = remaining_lamports
            .checked_sub(allocated)
            .ok_or(PingyError::AccountingUnderflow)?;
        remaining_tokens = remaining_tokens
            .checked_sub(wallet_tokens)
            .ok_or(PingyError::AccountingUnderflow)?;
    }

    require!(
        remaining_lamports == 0,
        PingyError::MissingApprovedReceiptAccounts
    );

    validate_room_ledger_accounting(room_ledger)?;

    Ok(())
}

fn allocate_v2_external_units<'info>(
    room_ledger: &mut Account<RoomLedger>,
    room_id: &str,
    use_amt: u64,
    remaining_accounts: &'info [AccountInfo<'info>],
) -> Result<()> {
    let mut remaining_lamports = use_amt;
    for account_info in remaining_accounts.iter() {
        let mut room_receipt: Account<RoomReceipt> = Account::try_from(account_info)?;
        require!(
            room_receipt.room_id == room_id,
            PingyError::InvalidReceiptRemainingAccount
        );
        require!(
            room_receipt.status == V2ReceiptStatus::Approved,
            PingyError::DepositNotApproved
        );

        let allocated = room_receipt.allocated_lamports;
        require!(
            allocated <= remaining_lamports,
            PingyError::InvalidReceiptRemainingAccount
        );

        let previous_status = room_receipt.status;
        room_receipt.forwarded_lamports = room_receipt
            .forwarded_lamports
            .checked_add(allocated)
            .ok_or(PingyError::AmountOverflow)?;
        // External entitlement is created here, at the on-chain freeze step. Later
        // record_external_distribution only records fulfillment against this basis.
        room_receipt.external_allocation_units = room_receipt
            .external_allocation_units
            .checked_add(allocated)
            .ok_or(PingyError::AmountOverflow)?;
        room_receipt.allocated_lamports = 0;
        room_receipt.status = V2ReceiptStatus::Converted;
        room_ledger.apply_v2_status_transition(previous_status, room_receipt.status)?;
        validate_room_receipt_accounting(&room_receipt)?;

        remaining_lamports = remaining_lamports
            .checked_sub(allocated)
            .ok_or(PingyError::AccountingUnderflow)?;
    }

    require!(
        remaining_lamports == 0,
        PingyError::MissingApprovedReceiptAccounts
    );

    validate_room_ledger_accounting(room_ledger)?;

    Ok(())
}

fn validate_room_receipt_accounting(room_receipt: &RoomReceipt) -> Result<()> {
    let bucket_total = room_receipt
        .refundable_lamports
        .checked_add(room_receipt.allocated_lamports)
        .ok_or(PingyError::AmountOverflow)?
        .checked_add(room_receipt.forwarded_lamports)
        .ok_or(PingyError::AmountOverflow)?
        .checked_add(room_receipt.refunded_lamports)
        .ok_or(PingyError::AmountOverflow)?;
    require!(
        room_receipt.bundle_lamports_total == bucket_total,
        PingyError::InvalidV2ReceiptAccounting
    );
    require!(
        room_receipt.native_tokens_claimed <= room_receipt.native_token_allocation,
        PingyError::InvalidV2ReceiptAccounting
    );
    require!(
        room_receipt.external_units_claimed <= room_receipt.external_allocation_units,
        PingyError::InvalidV2ReceiptAccounting
    );
    Ok(())
}

fn validate_room_ledger_accounting(room_ledger: &RoomLedger) -> Result<()> {
    let bucket_total = room_ledger
        .total_refundable_lamports
        .checked_add(room_ledger.total_allocated_lamports)
        .ok_or(PingyError::AmountOverflow)?
        .checked_add(room_ledger.total_forwarded_lamports)
        .ok_or(PingyError::AmountOverflow)?
        .checked_add(room_ledger.total_refunded_lamports)
        .ok_or(PingyError::AmountOverflow)?;
    require!(
        room_ledger.total_bundle_lamports == bucket_total,
        PingyError::InvalidV2RoomAccounting
    );
    require!(
        room_ledger.total_allocated_lamports <= room_ledger.spawn_target_lamports,
        PingyError::InvalidV2RoomAccounting
    );

    if room_ledger.launch_backend == V2_LAUNCH_BACKEND_EXTERNAL {
        require!(
            room_ledger.total_external_units_settled <= room_ledger.total_forwarded_lamports,
            PingyError::InvalidV2RoomAccounting
        );
        match room_ledger.external_settlement_status {
            V2ExternalSettlementStatus::Pending => require!(
                room_ledger.total_external_units_settled == 0,
                PingyError::InvalidV2RoomAccounting
            ),
            V2ExternalSettlementStatus::InProgress => require!(
                room_ledger.total_external_units_settled > 0
                    && room_ledger.total_external_units_settled
                        < room_ledger.total_forwarded_lamports,
                PingyError::InvalidV2RoomAccounting
            ),
            V2ExternalSettlementStatus::Complete => require!(
                room_ledger.total_external_units_settled == room_ledger.total_forwarded_lamports,
                PingyError::InvalidV2RoomAccounting
            ),
        }
    } else {
        require!(
            room_ledger.total_external_units_settled == 0,
            PingyError::InvalidV2RoomAccounting
        );
    }

    Ok(())
}

fn sync_room_external_settlement_status(room_ledger: &mut RoomLedger) -> Result<()> {
    require!(
        room_ledger.launch_backend == V2_LAUNCH_BACKEND_EXTERNAL,
        PingyError::InvalidLaunchBackendForRoom
    );
    room_ledger.external_settlement_status = if room_ledger.total_external_units_settled == 0 {
        V2ExternalSettlementStatus::Pending
    } else if room_ledger.total_external_units_settled == room_ledger.total_forwarded_lamports {
        V2ExternalSettlementStatus::Complete
    } else {
        V2ExternalSettlementStatus::InProgress
    };
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
    authority_seed_namespace: &'static [u8],
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

    let room_seed = room_seed_bytes(thread_id);
    let signer_seeds: &[&[&[u8]]] = &[&[
        authority_seed_namespace,
        room_seed.as_ref(),
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
        seeds = [b"thread", room_seed_bytes(&thread_id).as_ref()],
        bump
    )]
    pub thread: Account<'info, Thread>,
    #[account(
        init,
        payer = admin,
        space = 8 + Curve::LEN,
        seeds = [b"curve", room_seed_bytes(&thread_id).as_ref()],
        bump
    )]
    pub curve: Account<'info, Curve>,
    #[account(
        seeds = [b"curve_authority", room_seed_bytes(&thread_id).as_ref()],
        bump
    )]
    /// CHECK: PDA used as mint authority and token vault authority.
    pub curve_authority: UncheckedAccount<'info>,
    #[account(
        init,
        payer = admin,
        space = 8 + SpawnPool::LEN,
        seeds = [b"spawn_pool", room_seed_bytes(&thread_id).as_ref()],
        bump
    )]
    pub spawn_pool: Account<'info, SpawnPool>,
    #[account(
        init,
        payer = admin,
        space = 8 + ThreadEscrow::LEN,
        seeds = [b"escrow", room_seed_bytes(&thread_id).as_ref()],
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
        seeds = [b"thread", room_seed_bytes(&thread_id).as_ref()],
        bump
    )]
    pub thread: Account<'info, Thread>,
    #[account(
        mut,
        seeds = [b"curve", room_seed_bytes(&thread_id).as_ref()],
        bump
    )]
    pub curve: Account<'info, Curve>,
    #[account(
        seeds = [b"curve_authority", room_seed_bytes(&thread_id).as_ref()],
        bump
    )]
    /// CHECK: PDA used as mint authority and token vault authority.
    pub curve_authority: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = admin,
        seeds = [b"mint", room_seed_bytes(&thread_id).as_ref()],
        bump,
        mint::decimals = TOKEN_DECIMALS,
        mint::authority = curve_authority,
        mint::freeze_authority = curve_authority
    )]
    pub mint: Account<'info, Mint>,
    #[account(
        init_if_needed,
        payer = admin,
        seeds = [b"curve_token_vault", room_seed_bytes(&thread_id).as_ref()],
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
        seeds = [b"thread", room_seed_bytes(&thread_id).as_ref()],
        bump
    )]
    pub thread: Account<'info, Thread>,
    #[account(
        init_if_needed,
        payer = user,
        space = 8 + Deposit::SIZE,
        seeds = [b"deposit", room_seed_bytes(&thread_id).as_ref(), user.key().as_ref()],
        bump
    )]
    pub deposit: Account<'info, Deposit>,
    #[account(
        mut,
        seeds = [b"escrow", room_seed_bytes(&thread_id).as_ref()],
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
        seeds = [b"thread", room_seed_bytes(&thread_id).as_ref()],
        bump
    )]
    pub thread: Account<'info, Thread>,
    #[account(
        mut,
        seeds = [b"deposit", room_seed_bytes(&thread_id).as_ref(), user_pubkey.as_ref()],
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
        seeds = [b"thread", room_seed_bytes(&thread_id).as_ref()],
        bump
    )]
    pub thread: Account<'info, Thread>,
    #[account(
        mut,
        seeds = [b"deposit", room_seed_bytes(&thread_id).as_ref(), user_pubkey.as_ref()],
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
        seeds = [b"thread", room_seed_bytes(&thread_id).as_ref()],
        bump
    )]
    pub thread: Account<'info, Thread>,
    #[account(
        mut,
        seeds = [b"deposit", room_seed_bytes(&thread_id).as_ref(), user.key().as_ref()],
        bump,
        close = user
    )]
    pub deposit: Account<'info, Deposit>,
    #[account(
        mut,
        seeds = [b"escrow", room_seed_bytes(&thread_id).as_ref()],
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
        seeds = [b"thread", room_seed_bytes(&thread_id).as_ref()],
        bump
    )]
    pub thread: Account<'info, Thread>,
    #[account(
        mut,
        seeds = [b"curve", room_seed_bytes(&thread_id).as_ref()],
        bump,
        constraint = curve.thread_id == thread_id @ PingyError::ThreadMismatch
    )]
    pub curve: Account<'info, Curve>,
    #[account(
        seeds = [b"curve_authority", room_seed_bytes(&thread_id).as_ref()],
        bump = curve.curve_authority_bump
    )]
    /// CHECK: PDA used as mint authority and token vault authority.
    pub curve_authority: UncheckedAccount<'info>,
    #[account(mut, address = curve.mint)]
    pub mint: Account<'info, Mint>,
    #[account(
        mut,
        seeds = [b"curve_token_vault", room_seed_bytes(&thread_id).as_ref()],
        bump,
        address = curve.curve_token_vault,
        token::mint = mint,
        token::authority = curve_authority
    )]
    pub curve_token_vault: Account<'info, TokenAccount>,
    #[account(
        mut,
        seeds = [b"escrow", room_seed_bytes(&thread_id).as_ref()],
        bump,
        constraint = thread_escrow.thread_id == thread_id @ PingyError::ThreadMismatch
    )]
    pub thread_escrow: Account<'info, ThreadEscrow>,
    #[account(
        mut,
        seeds = [b"spawn_pool", room_seed_bytes(&thread_id).as_ref()],
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
        seeds = [b"thread", room_seed_bytes(&thread_id).as_ref()],
        bump
    )]
    pub thread: Account<'info, Thread>,
    #[account(
        seeds = [b"curve", room_seed_bytes(&thread_id).as_ref()],
        bump,
        constraint = curve.thread_id == thread_id @ PingyError::ThreadMismatch
    )]
    pub curve: Account<'info, Curve>,
    #[account(
        mut,
        seeds = [b"deposit", room_seed_bytes(&thread_id).as_ref(), user.key().as_ref()],
        bump
    )]
    pub deposit: Account<'info, Deposit>,
    #[account(
        seeds = [b"curve_authority", room_seed_bytes(&thread_id).as_ref()],
        bump = curve.curve_authority_bump
    )]
    /// CHECK: PDA used as mint authority and token vault authority.
    pub curve_authority: UncheckedAccount<'info>,
    #[account(address = curve.mint)]
    pub mint: Account<'info, Mint>,
    #[account(
        mut,
        seeds = [b"curve_token_vault", room_seed_bytes(&thread_id).as_ref()],
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
        seeds = [b"thread", room_seed_bytes(&thread_id).as_ref()],
        bump
    )]
    pub thread: Account<'info, Thread>,
    #[account(
        mut,
        seeds = [b"curve", room_seed_bytes(&thread_id).as_ref()],
        bump,
        constraint = curve.thread_id == thread_id @ PingyError::ThreadMismatch
    )]
    pub curve: Account<'info, Curve>,
    #[account(
        seeds = [b"curve_authority", room_seed_bytes(&thread_id).as_ref()],
        bump = curve.curve_authority_bump
    )]
    /// CHECK: PDA used as token vault authority.
    pub curve_authority: UncheckedAccount<'info>,
    #[account(mut, address = curve.mint)]
    pub mint: Account<'info, Mint>,
    #[account(
        mut,
        seeds = [b"curve_token_vault", room_seed_bytes(&thread_id).as_ref()],
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
        seeds = [b"spawn_pool", room_seed_bytes(&thread_id).as_ref()],
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
        seeds = [b"thread", room_seed_bytes(&thread_id).as_ref()],
        bump
    )]
    pub thread: Account<'info, Thread>,
    #[account(
        mut,
        seeds = [b"curve", room_seed_bytes(&thread_id).as_ref()],
        bump,
        constraint = curve.thread_id == thread_id @ PingyError::ThreadMismatch
    )]
    pub curve: Account<'info, Curve>,
    #[account(
        seeds = [b"curve_authority", room_seed_bytes(&thread_id).as_ref()],
        bump = curve.curve_authority_bump
    )]
    /// CHECK: PDA used as token vault authority.
    pub curve_authority: UncheckedAccount<'info>,
    #[account(mut, address = curve.mint)]
    pub mint: Account<'info, Mint>,
    #[account(
        mut,
        seeds = [b"curve_token_vault", room_seed_bytes(&thread_id).as_ref()],
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
        seeds = [b"spawn_pool", room_seed_bytes(&thread_id).as_ref()],
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

#[derive(Accounts)]
pub struct InitializeV2GlobalState<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        init,
        payer = admin,
        space = 8 + ProgramState::LEN,
        seeds = [b"program_state_v2"],
        bump
    )]
    pub program_state: Account<'info, ProgramState>,
    #[account(
        init,
        payer = admin,
        space = 8 + SharedVault::LEN,
        seeds = [b"shared_vault_v2"],
        bump
    )]
    pub shared_vault: Account<'info, SharedVault>,
    #[account(
        init,
        payer = admin,
        space = 8 + V2FeeVault::LEN,
        seeds = [b"fee_vault_v2"],
        bump
    )]
    pub fee_vault: Account<'info, V2FeeVault>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(room_id: String)]
pub struct CreateRoomLedger<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        seeds = [b"program_state_v2"],
        bump = program_state.bump
    )]
    pub program_state: Account<'info, ProgramState>,
    #[account(
        init,
        payer = admin,
        space = 8 + RoomLedger::LEN,
        seeds = [b"room_ledger", room_seed_bytes(&room_id).as_ref()],
        bump
    )]
    pub room_ledger: Account<'info, RoomLedger>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(room_id: String)]
pub struct PingDepositShared<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        seeds = [b"program_state_v2"],
        bump = program_state.bump
    )]
    pub program_state: Account<'info, ProgramState>,
    #[account(
        mut,
        seeds = [b"shared_vault_v2"],
        bump = shared_vault.bump
    )]
    pub shared_vault: Account<'info, SharedVault>,
    #[account(
        mut,
        seeds = [b"room_ledger", room_seed_bytes(&room_id).as_ref()],
        bump = room_ledger.bump
    )]
    pub room_ledger: Account<'info, RoomLedger>,
    #[account(
        init_if_needed,
        payer = user,
        space = 8 + RoomReceipt::LEN,
        seeds = [b"room_receipt", room_seed_bytes(&room_id).as_ref(), user.key().as_ref()],
        bump
    )]
    pub room_receipt: Account<'info, RoomReceipt>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(room_id: String)]
pub struct CreateRoomReceiptForUser<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        mut,
        seeds = [b"room_ledger", room_seed_bytes(&room_id).as_ref()],
        bump = room_ledger.bump
    )]
    pub room_ledger: Account<'info, RoomLedger>,
    #[account(
        init,
        payer = user,
        space = 8 + RoomReceipt::LEN,
        seeds = [b"room_receipt", room_seed_bytes(&room_id).as_ref(), user.key().as_ref()],
        bump
    )]
    pub room_receipt: Account<'info, RoomReceipt>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(room_id: String, user_pubkey: Pubkey)]
pub struct ApproveReceipt<'info> {
    #[account(mut, address = room_ledger.admin_pubkey)]
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [b"room_ledger", room_seed_bytes(&room_id).as_ref()],
        bump = room_ledger.bump
    )]
    pub room_ledger: Account<'info, RoomLedger>,
    #[account(
        mut,
        seeds = [b"room_receipt", room_seed_bytes(&room_id).as_ref(), user_pubkey.as_ref()],
        bump = room_receipt.bump
    )]
    pub room_receipt: Account<'info, RoomReceipt>,
}

#[derive(Accounts)]
#[instruction(room_id: String, user_pubkey: Pubkey)]
pub struct RevokeReceipt<'info> {
    #[account(mut, address = room_ledger.admin_pubkey)]
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [b"room_ledger", room_seed_bytes(&room_id).as_ref()],
        bump = room_ledger.bump
    )]
    pub room_ledger: Account<'info, RoomLedger>,
    #[account(
        mut,
        seeds = [b"room_receipt", room_seed_bytes(&room_id).as_ref(), user_pubkey.as_ref()],
        bump = room_receipt.bump
    )]
    pub room_receipt: Account<'info, RoomReceipt>,
}

#[derive(Accounts)]
#[instruction(room_id: String)]
pub struct UnpingRefund<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        seeds = [b"program_state_v2"],
        bump = program_state.bump
    )]
    pub program_state: Account<'info, ProgramState>,
    #[account(
        mut,
        seeds = [b"shared_vault_v2"],
        bump = shared_vault.bump
    )]
    pub shared_vault: Account<'info, SharedVault>,
    #[account(
        mut,
        seeds = [b"room_ledger", room_seed_bytes(&room_id).as_ref()],
        bump = room_ledger.bump
    )]
    pub room_ledger: Account<'info, RoomLedger>,
    #[account(
        mut,
        seeds = [b"room_receipt", room_seed_bytes(&room_id).as_ref(), user.key().as_ref()],
        bump = room_receipt.bump,
        close = user
    )]
    pub room_receipt: Account<'info, RoomReceipt>,
}

#[derive(Accounts)]
#[instruction(room_id: String)]
pub struct ExecuteSpawnNative<'info> {
    #[account(mut, address = room_ledger.admin_pubkey)]
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [b"shared_vault_v2"],
        bump = shared_vault.bump
    )]
    pub shared_vault: Account<'info, SharedVault>,
    #[account(
        mut,
        seeds = [b"fee_vault_v2"],
        bump = fee_vault.bump
    )]
    pub fee_vault: Account<'info, V2FeeVault>,
    #[account(
        mut,
        seeds = [b"room_ledger", room_seed_bytes(&room_id).as_ref()],
        bump = room_ledger.bump
    )]
    pub room_ledger: Account<'info, RoomLedger>,
    #[account(
        init,
        payer = admin,
        space = 8 + Curve::LEN,
        seeds = [b"v2_curve", room_seed_bytes(&room_id).as_ref()],
        bump
    )]
    pub curve: Account<'info, Curve>,
    #[account(
        seeds = [b"v2_curve_authority", room_seed_bytes(&room_id).as_ref()],
        bump
    )]
    /// CHECK: PDA used as mint authority and token vault authority.
    pub curve_authority: UncheckedAccount<'info>,
    #[account(
        init,
        payer = admin,
        seeds = [b"v2_mint", room_seed_bytes(&room_id).as_ref()],
        bump,
        mint::decimals = TOKEN_DECIMALS,
        mint::authority = curve_authority,
        mint::freeze_authority = curve_authority
    )]
    pub mint: Account<'info, Mint>,
    #[account(
        init,
        payer = admin,
        seeds = [b"v2_curve_token_vault", room_seed_bytes(&room_id).as_ref()],
        bump,
        token::mint = mint,
        token::authority = curve_authority
    )]
    pub curve_token_vault: Account<'info, TokenAccount>,
    #[account(
        init,
        payer = admin,
        space = 8 + SpawnPool::LEN,
        seeds = [b"v2_spawn_pool", room_seed_bytes(&room_id).as_ref()],
        bump
    )]
    pub spawn_pool: Account<'info, SpawnPool>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(room_id: String)]
pub struct ExecuteSpawnExternal<'info> {
    #[account(mut, address = room_ledger.admin_pubkey)]
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [b"shared_vault_v2"],
        bump = shared_vault.bump
    )]
    pub shared_vault: Account<'info, SharedVault>,
    #[account(
        mut,
        seeds = [b"fee_vault_v2"],
        bump = fee_vault.bump
    )]
    pub fee_vault: Account<'info, V2FeeVault>,
    #[account(
        mut,
        seeds = [b"room_ledger", room_seed_bytes(&room_id).as_ref()],
        bump = room_ledger.bump
    )]
    pub room_ledger: Account<'info, RoomLedger>,
}

#[derive(Accounts)]
#[instruction(room_id: String)]
pub struct ClaimSpawnTokensV2<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        seeds = [b"room_ledger", room_seed_bytes(&room_id).as_ref()],
        bump = room_ledger.bump
    )]
    pub room_ledger: Account<'info, RoomLedger>,
    #[account(
        mut,
        seeds = [b"room_receipt", room_seed_bytes(&room_id).as_ref(), user.key().as_ref()],
        bump = room_receipt.bump
    )]
    pub room_receipt: Account<'info, RoomReceipt>,
    #[account(
        mut,
        seeds = [b"v2_curve", room_seed_bytes(&room_id).as_ref()],
        bump
    )]
    pub curve: Account<'info, Curve>,
    #[account(
        seeds = [b"v2_curve_authority", room_seed_bytes(&room_id).as_ref()],
        bump = curve.curve_authority_bump
    )]
    /// CHECK: PDA used as token vault authority.
    pub curve_authority: UncheckedAccount<'info>,
    #[account(address = curve.mint)]
    pub mint: Account<'info, Mint>,
    #[account(
        mut,
        seeds = [b"v2_curve_token_vault", room_seed_bytes(&room_id).as_ref()],
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
#[instruction(room_id: String)]
pub struct RecordExternalDistribution<'info> {
    #[account(mut, address = room_ledger.admin_pubkey)]
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [b"room_ledger", room_seed_bytes(&room_id).as_ref()],
        bump = room_ledger.bump
    )]
    pub room_ledger: Account<'info, RoomLedger>,
    #[account(
        mut,
        constraint = room_receipt.room_id == room_id @ PingyError::ReceiptMismatch
    )]
    pub room_receipt: Account<'info, RoomReceipt>,
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

#[account]
pub struct ProgramState {
    pub version: u8,
    pub admin_pubkey: Pubkey,
    pub shared_vault: Pubkey,
    pub fee_vault: Pubkey,
    pub default_ping_fee_recipient: Pubkey,
    pub bump: u8,
}

#[account]
pub struct SharedVault {
    pub version: u8,
    pub bump: u8,
    pub total_reserved_lamports: u64,
}

#[account]
pub struct V2FeeVault {
    pub version: u8,
    pub bump: u8,
    pub spawn_fee_lamports_accrued: u64,
    pub trade_fee_lamports_accrued: u64,
}

#[account]
pub struct RoomLedger {
    pub version: u8,
    pub bump: u8,
    pub room_id: String,
    pub creator_pubkey: Pubkey,
    pub admin_pubkey: Pubkey,
    pub launch_backend: u8,
    pub launch_mode: u8,
    pub state: V2RoomState,
    pub min_approved_wallets: u32,
    pub spawn_target_lamports: u64,
    pub max_wallet_share_bps: u16,
    pub pending_count: u32,
    pub approved_count: u32,
    pub total_bundle_lamports: u64,
    pub total_refundable_lamports: u64,
    pub total_allocated_lamports: u64,
    pub total_forwarded_lamports: u64,
    pub total_refunded_lamports: u64,
    pub spawn_finalized: bool,
    pub mint: Pubkey,
    pub curve: Pubkey,
    pub spawn_pool: Pubkey,
    pub curve_token_vault: Pubkey,
    pub external_settlement_mode: u8,
    pub external_settlement_status: V2ExternalSettlementStatus,
    pub total_external_units_settled: u64,
}

#[account]
pub struct RoomReceipt {
    pub version: u8,
    pub bump: u8,
    pub room_id: String,
    pub user_pubkey: Pubkey,
    pub status: V2ReceiptStatus,
    pub bundle_lamports_total: u64,
    pub refundable_lamports: u64,
    pub allocated_lamports: u64,
    pub forwarded_lamports: u64,
    pub refunded_lamports: u64,
    pub receipt_backing_lamports: u64,
    pub native_token_allocation: u64,
    pub native_tokens_claimed: u64,
    pub external_allocation_units: u64,
    pub external_units_claimed: u64,
}

impl ThreadEscrow {
    pub const MAX_THREAD_ID_LEN: usize = 64;
    pub const LEN: usize = 4 + Self::MAX_THREAD_ID_LEN;
}

impl FeeVault {
    pub const SIZE: usize = 1;
}

impl ProgramState {
    pub const LEN: usize = 1 + 32 + 32 + 32 + 32 + 1;
}

impl SharedVault {
    pub const LEN: usize = 1 + 1 + 8;
}

impl V2FeeVault {
    pub const LEN: usize = 1 + 1 + 8 + 8;
}

impl RoomLedger {
    pub const MAX_ROOM_ID_LEN: usize = 64;
    pub const LEN: usize = 1
        + 1
        + 4
        + Self::MAX_ROOM_ID_LEN
        + 32
        + 32
        + 1
        + 1
        + 1
        + 4
        + 8
        + 2
        + 4
        + 4
        + 8
        + 8
        + 8
        + 8
        + 8
        + 1
        + 32
        + 32
        + 32
        + 32
        + 1
        + 1
        + 8;

    fn increment_v2_status_count(&mut self, new_status: V2ReceiptStatus) -> Result<()> {
        match new_status {
            V2ReceiptStatus::Pending => {
                self.pending_count = self
                    .pending_count
                    .checked_add(1)
                    .ok_or(PingyError::AmountOverflow)?;
            }
            V2ReceiptStatus::Approved => {
                self.approved_count = self
                    .approved_count
                    .checked_add(1)
                    .ok_or(PingyError::AmountOverflow)?;
            }
            _ => {}
        }
        Ok(())
    }

    fn decrement_v2_status_count(&mut self, old_status: V2ReceiptStatus) -> Result<()> {
        match old_status {
            V2ReceiptStatus::Pending => {
                self.pending_count = self
                    .pending_count
                    .checked_sub(1)
                    .ok_or(PingyError::AccountingUnderflow)?;
            }
            V2ReceiptStatus::Approved => {
                self.approved_count = self
                    .approved_count
                    .checked_sub(1)
                    .ok_or(PingyError::AccountingUnderflow)?;
            }
            _ => {}
        }
        Ok(())
    }

    fn apply_v2_status_transition(
        &mut self,
        old: V2ReceiptStatus,
        new: V2ReceiptStatus,
    ) -> Result<()> {
        if old == new {
            return Ok(());
        }
        self.decrement_v2_status_count(old)?;
        self.increment_v2_status_count(new)?;
        Ok(())
    }
}

impl RoomReceipt {
    pub const MAX_ROOM_ID_LEN: usize = 64;
    pub const LEN: usize =
        1 + 1 + 4 + Self::MAX_ROOM_ID_LEN + 32 + 1 + 8 + 8 + 8 + 8 + 8 + 8 + 8 + 8 + 8 + 8;
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

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum V2RoomState {
    Open,
    NativeBonding,
    NativeBonded,
    ExternalFinalized,
    Cancelled,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum V2ReceiptStatus {
    Pending,
    Approved,
    Revoked,
    Withdrawn,
    Converted,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum V2ExternalSettlementStatus {
    Pending,
    InProgress,
    Complete,
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
    #[msg("Launch backend is invalid")]
    InvalidLaunchBackend,
    #[msg("Room ledger does not match the requested room id")]
    RoomLedgerMismatch,
    #[msg("V2 room is not open")]
    V2RoomNotOpen,
    #[msg("Room receipt does not match the requested room id")]
    ReceiptMismatch,
    #[msg("Room launch backend does not allow this operation")]
    InvalidLaunchBackendForRoom,
    #[msg("V2 room has not been spawned")]
    V2RoomNotSpawned,
    #[msg("Missing approved room receipt accounts required for spawn allocation")]
    MissingApprovedReceiptAccounts,
    #[msg("Invalid room receipt passed as a remaining account")]
    InvalidReceiptRemainingAccount,
    #[msg("Room receipt accounting buckets are inconsistent")]
    InvalidV2ReceiptAccounting,
    #[msg("Room ledger accounting buckets are inconsistent")]
    InvalidV2RoomAccounting,
    #[msg("External settlement cannot exceed previously assigned entitlement")]
    ExternalDistributionExceedsEntitlement,
    #[msg("External settlement is not ready for this receipt")]
    ExternalSettlementNotReady,
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
