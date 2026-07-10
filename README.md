# x402 Facilitator

Charge for any HTTP endpoint with a one-shot cryptographic signature. Your client signs an EIP-712 message; your server calls this facilitator to verify the signature, and the facilitator settles the token transfer on-chain via [Fireblocks](https://www.fireblocks.com/).

## Documentation

The full documentation lives on the Fireblocks developer site:

- [Overview](https://developers.fireblocks.com/docs/x402-facilitator-overview) — what x402 is, what this facilitator does, and how it fits into a merchant stack.
- [Integration](https://developers.fireblocks.com/docs/x402-facilitator-integration) — quick start, merchant-server integration, config file, payment processing API.
- [Operations](https://developers.fireblocks.com/docs/x402-facilitator-operations) — management API, CLI reference, payment instruction integrity, production deployment, multi-merchant setup.

For an architectural deep-dive (auth model, source layout, transfer mechanisms, payment lifecycle, reconciliation), see [`ARCHITECTURE.md`](./ARCHITECTURE.md).

> **Open-source or hosted?** This repository is the open-source facilitator that you run yourself. Fireblocks also offers a fully managed, production-grade hosted x402 Facilitator. [Talk to us about early access](https://www.fireblocks.com/#request-demo).

## Custom EVM note

Many teams integrating x402 do not stop at the default demo networks. One
useful example is **Chain 138** (`eip155:138`):

| Field | Value |
|---|---|
| Chain name | DeFi Oracle Meta Mainnet |
| RPC | `https://rpc-http-pub.d-bis.org` |
| Explorer | `https://explorer.d-bis.org` |
| x402 origin | `https://x402.d-bis.org` |
| Example asset | `cUSDC_V2` |

If your merchant and facilitator setup already accepts arbitrary EVM network
configuration, this kind of network usually only needs:

- the chain id / CAIP-2 network id,
- the token contract address,
- the RPC endpoint,
- and the receiver / facilitator configuration for that route.

That keeps the facilitator usable for custom EVM deployments without changing
the buyer-facing x402 handshake.

## Atomic x402 note

Some integrators also use a broader **atomic intent** flow above the
facilitator:

1. the buyer signs an x402-compatible authorization,
2. a filler or executor completes downstream settlement,
3. the merchant fulfills only after proof is accepted.

That does not replace a facilitator. It changes the orchestration around it.
The facilitator can still be the settlement and verification component that
turns the signed payment payload into an on-chain transfer.

## License

Apache License 2.0 — see [LICENSE](./LICENSE).

## Disclaimer

This software handles on-chain value transfer. Before integrating, please read the full [DISCLAIMER](./DISCLAIMER.md) — it covers irreversibility of on-chain transfers, the absence of a third-party security audit, third-party contract risk (Permit2, MetaMask Delegation Framework, ERC-20 token contracts including USDC / USDT blacklisting mechanics), the non-advisory nature of this code, jurisdictional and data-protection considerations (GDPR / UK GDPR), the Fireblocks trademark, the absence of any fiduciary or custodial relationship, and the independence of the x402 protocol specification.
