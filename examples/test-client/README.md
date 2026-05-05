# x402 test client

Lightweight x402 payer that uses a local `ethers.Wallet` to sign each mechanism's payload and hits a merchant URL. No Fireblocks on the client side — only the facilitator still submits the on-chain settlement through Fireblocks.

Useful for end-to-end testing of the merchant + facilitator across every supported transfer mechanism without setting up a second Fireblocks vault for the payer.

## Supported mechanisms

| `MECHANISM=` | What the EOA signs | On-chain action the EOA needs |
|---|---|---|
| `eip3009` (default) | EIP-3009 `TransferWithAuthorization` | — (signature only) |
| `permit2` | Uniswap Permit2 `PermitWitnessTransferFrom` | One-time `approve(Permit2, MAX)` on the USDC contract |
| `erc7710` | MetaMask Delegation Framework `Delegation` | One-time EIP-7702 self-upgrade to `EIP7702StatelessDeleGator` |

## Setup

```bash
# 1. Generate a dev private key (or use an existing one)
node -e "console.log(require('ethers').Wallet.createRandom().privateKey)"

# 2. Export it
export PRIVATE_KEY=0x...

# 3. Print the address you need to fund
npm run whoami
```

## Funding the EOA

Every run does a preflight balance check and exits with a fund-me block if the EOA is short. What you need depends on the mechanism:

| Mechanism | USDC | ETH (for gas) |
|---|---|---|
| `eip3009` | yes, ≥ payment amount | — |
| `permit2` (first run) | yes | yes, a few cents worth (covers one `approve` tx) |
| `permit2` (subsequent) | yes | — |
| `erc7710` (first run) | yes | yes, a few cents worth (covers one EIP-7702 self-upgrade tx) |
| `erc7710` (subsequent) | yes | — |

### Faucets (all require captcha / social login by design)

**Ethereum Sepolia ETH**
- https://www.alchemy.com/faucets/ethereum-sepolia
- https://sepolia-faucet.pk910.de  (PoW — no login required)
- https://faucets.chain.link/sepolia

**Base Sepolia ETH**
- https://www.alchemy.com/faucets/base-sepolia
- https://portal.cdp.coinbase.com/products/faucet

**USDC (both chains)**
- https://faucet.circle.com  → select the network, paste the EOA address, claim

Each paste/claim takes ~30 seconds. The facilitator's vault also needs gas ETH on whichever chain it settles on — that's a separate thing, documented in the facilitator README.

## Run

```bash
# Merchant on :3010, facilitator on :3000.
npm run dev

# Force a specific mechanism and/or chain:
MECHANISM=permit2    CHAIN=11155111 AUTO_APPROVE=true npm run dev
MECHANISM=erc7710    CHAIN=11155111 npm run dev
MECHANISM=eip3009    CHAIN=84532    npm run dev
```

Each run:
1. Hits the merchant and expects a **402** with one or more `accepts[]` entries.
2. Picks a `(chain, mechanism)` — `CHAIN` / `MECHANISM` env overrides, otherwise by balance probe.
3. Runs a preflight check — prints fund-me instructions and exits if underfunded.
4. Submits any one-time on-chain setup (`approve` for Permit2, EIP-7702 upgrade for ERC-7710).
5. Signs the right payload for the chosen mechanism.
6. Retries with the `payment-signature` header.
7. Prints the merchant's response + the settlement tx hash (from `PAYMENT-RESPONSE`).

## Env

| Variable | Default | Purpose |
|----------|---------|---------|
| `PRIVATE_KEY` | (required) | EOA that pays |
| `MERCHANT_URL` | `http://localhost:3010/premium` | URL to pay for |
| `RPC_URL_ETH_SEPOLIA` | `https://ethereum-sepolia-rpc.publicnode.com` | Read-only RPC for balance + `approve` + 7702 |
| `RPC_URL_BASE_SEPOLIA` | `https://sepolia.base.org` | Same, for Base Sepolia |
| `CHAIN` | auto | Force `84532` or `11155111` |
| `MECHANISM` | auto | Force `eip3009` / `permit2` / `erc7710` |
| `AUTO_APPROVE` | `false` | For `permit2` — submit `approve(Permit2, MAX)` on-chain if allowance is 0 |
| `SKIP_BALANCE_CHECK` | `false` | Legacy flag; preflight is always on now |
