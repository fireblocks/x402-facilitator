# x402 Facilitator

Charge for any HTTP endpoint with a one-shot cryptographic signature. Your client signs an EIP-712 message; your server calls this facilitator to verify the signature, and the facilitator settles the token transfer on-chain via [Fireblocks](https://www.fireblocks.com/).

## Documentation

The full documentation lives on the Fireblocks developer site:

- [Overview](https://developers.fireblocks.com/docs/x402-facilitator-overview) — what x402 is, what this facilitator does, and how it fits into a merchant stack.
- [Integration](https://developers.fireblocks.com/docs/x402-facilitator-integration) — quick start, merchant-server integration, config file, payment processing API.
- [Operations](https://developers.fireblocks.com/docs/x402-facilitator-operations) — management API, CLI reference, payment instruction integrity, production deployment, multi-merchant setup.

For an architectural deep-dive (auth model, source layout, transfer mechanisms, payment lifecycle, reconciliation), see [`ARCHITECTURE.md`](./ARCHITECTURE.md).

## Behavior notes

- `packages/x402-express` optimistic settlement only settles after a successful downstream response. If the protected handler returns `4xx`/`5xx`, the middleware does not charge the payer in the background.
- Host-bound public routes are strict in multi-configuration deployments: `/.well-known/did.json` serves only for a matching `public_host`, and unknown hosts do not fall back to the default configuration.
- `upto-permit2` requests must carry `paymentRequirements.extra.facilitatorAddress`, and the facilitator verifies that value against the signed witness binding before accepting `/verify` or `/settle`.
- `/api/payments/supported` is configuration-scoped. It advertises only schemes, networks, and signer addresses referenced by products in the resolved configuration.

> **Open-source or hosted?** This repository is the open-source facilitator that you run yourself. Fireblocks also offers a fully managed, production-grade hosted x402 Facilitator. [Talk to us about early access](https://www.fireblocks.com/#request-demo).

## License

Apache License 2.0 — see [LICENSE](./LICENSE).

## Disclaimer

This software handles on-chain value transfer. Before integrating, please read the full [DISCLAIMER](./DISCLAIMER.md) — it covers irreversibility of on-chain transfers, the absence of a third-party security audit, third-party contract risk (Permit2, MetaMask Delegation Framework, ERC-20 token contracts including USDC / USDT blacklisting mechanics), the non-advisory nature of this code, jurisdictional and data-protection considerations (GDPR / UK GDPR), the Fireblocks trademark, the absence of any fiduciary or custodial relationship, and the independence of the x402 protocol specification.
