# Disclaimer

This software is provided as open-source reference code. See LICENSE (Apache License 2.0) for the legal terms that govern use, reproduction, and distribution. The items below are non-normative, operational notices to help integrators understand risks of running payment-processing code on public blockchains; they do not modify the license. Nothing herein is financial, legal, tax, or compliance advice; consult your own qualified advisors. This software implements the x402 open payment protocol, which is a third-party specification maintained independently of Fireblocks. Fireblocks makes no representations as to the accuracy, completeness, stability, or continued availability of the x402 protocol specification, and accepts no responsibility for changes to that specification or for the behaviour of other implementations of it.

> **Scope of this disclaimer:** This disclaimer addresses operators — entities that deploy and operate an instance of this facilitator on their own infrastructure. Operators are responsible for any disclosures they make to their own users.

## 1. On-chain transfers are irreversible

This facilitator initiates real, on-chain value transfers (typically USDC and other ERC-20 stablecoins) on EVM-compatible networks. Once a transaction is broadcast and confirmed on-chain, it cannot be reversed, recalled, or refunded by Fireblocks, by the operator of a facilitator instance, or by any other party. Bugs in your integration, misconfiguration of pricing or destination addresses, signed authorizations that are intercepted before settlement, or upstream contract behaviour you did not anticipate may result in permanent loss of funds. You are responsible for testing thoroughly on testnets before enabling mainnet, for reviewing every configuration change, and for understanding the on-chain calls this software causes a Fireblocks vault to make on your behalf. Additionally, the `upto-permit2` mechanism permits the facilitator to select the actual charge amount up to a user's signed maximum; operators are responsible for ensuring their pricing logic does not cause unintended charges within that ceiling.

## 2. No third-party security audit

As of publication, the code in this repository has not undergone a third-party security audit. It has been reviewed internally by Fireblocks engineers and has had a pre-publication hardening pass focused on common payment-flow risks (replay protection, idempotency, on-chain simulation gating before settlement, mainnet default-deny configuration, etc.), but that internal review is not a substitute for an independent audit. Operators who plan to use this in production environments handling material value should commission their own independent security assessment.

## 3. Third-party contract risk

This software interacts with smart contracts that are not owned, operated, or maintained by Fireblocks, including but not limited to:

- **ERC-20 token contracts** — every token integrated by an operator (USDC, USDT, and others) is a third-party contract whose behaviour, upgradeability, blacklist mechanics, and pause functionality are controlled by the token issuer. In particular, the USDC contract (issued by Circle) includes an on-chain blacklisting mechanism that enables Circle to freeze transfers to or from a designated address; the USDT contract (issued by Tether) includes an analogous address-blocking function. A payment initiated to or from a blacklisted or blocked address will fail at the contract level. Fireblocks has no control over and accepts no responsibility for any token issuer's exercise of these functions.
- **Permit2** (e.g., `0x000000000022D473030F116dDEE9F6B43aC78BA3`, deployed deterministically on supported chains; always validate addresses per chain and version) — the canonical Uniswap-deployed signature-based approval contract on multiple EVM chains.
- **MetaMask Delegation Framework (MDF)** — the `DelegationManager` and related contracts used by the `erc7710` transfer mechanism, deployed and maintained by ConsenSys / MetaMask.
- **Network-specific x402 facilitator proxy contracts**, where applicable, that are deployed and maintained by third parties on certain chains.
- The underlying **EVM blockchain networks** themselves (Ethereum, Base, Polygon, etc.).

Bugs, vulnerabilities, governance changes, upgrades, deprecations, paused states, or sanctions actions affecting any of these external contracts can directly impact the success or safety of payments processed by this facilitator. Fireblocks does not control these contracts and cannot warrant their behaviour. Operators should verify contract addresses and deployment state independently on each chain, and use strict allowlists and simulations consistent with this repository's configuration and examples.

## 4. Not financial, legal, tax, or compliance advice

Nothing in this repository — code, comments, documentation, examples, configuration files — constitutes financial advice, investment advice, legal advice, tax advice, accounting advice, or compliance advice. Operating a payment facilitator may carry obligations under money-transmission, consumer-protection, anti-money-laundering, sanctions, securities, and tax laws in your jurisdiction and in your customers' jurisdictions. You are responsible for determining, with your own qualified advisors, whether and how you may lawfully operate an instance of this software, including any registrations, licences, disclosures, KYC/AML controls, sanctions screening, export controls, and reporting obligations that may apply to you. This software may process personal data (including wallet addresses and transaction metadata) in connection with its operation. Operators are independently responsible for compliance with applicable data protection and privacy laws — including, without limitation, the EU General Data Protection Regulation (GDPR), the UK GDPR, and equivalent legislation in other jurisdictions — including determining the applicable legal basis for any processing, fulfilling data-subject rights obligations, and putting in place any required data-processing agreements with sub-processors. Fireblocks is not your data processor in respect of personal data processed by software you operate on your own infrastructure.

## 5. Jurisdictional considerations

The availability and operation of this software, and of the digital-asset transfers it can initiate, may be restricted, regulated, or prohibited in certain jurisdictions or with respect to certain counterparties. Some jurisdictions impose specific licensing requirements on payment processors, virtual-asset service providers, or money transmitters; others restrict or prohibit certain digital assets entirely or for certain residents; export-control and sanctions regimes may also apply. This software must not be operated in jurisdictions where such operation is unlawful, or by or on behalf of any person or entity subject to comprehensive sanctions imposed by any country, region, or authority. It is your obligation, not Fireblocks', to ensure compliance with all applicable laws and regulations in every jurisdiction where you operate or where your customers are located.

## 6. No warranty, no support obligation

This software is provided "AS IS" and on an "AS AVAILABLE" basis, without warranties of any kind, express or implied, as further set forth in the Apache License. Fireblocks has no obligation under this repository to provide support, maintenance, bug fixes, security patches, or upgrades, although we may choose to do so at our discretion. Issues filed in the repository's issue tracker may receive a response, but no service-level commitment is made.

## 7. Trademark

"Fireblocks" and the Fireblocks logos are trademarks of Fireblocks Ltd. The Apache License 2.0 grants you rights to the source code; it does not grant rights to use the Fireblocks name, logos, or other Fireblocks trademarks. You may not represent your fork, deployment, or product as endorsed by, affiliated with, or operated by Fireblocks without Fireblocks' prior written permission. Factual references and attributions such as "this fork is based on the Fireblocks x402 Facilitator (Apache-2.0)" are permitted; representations of endorsement, partnership, or origin beyond such factual references and attributions are not.

## 8. Reporting security issues

If you believe you have found a security vulnerability, please report it privately to security@fireblocks.com as described in [SECURITY.md](./SECURITY.md). Please do not file public issues for suspected vulnerabilities.

## 9. No fiduciary, custodial, or agency relationship

Nothing in this software or in any documentation, example, or configuration associated with it creates or implies any fiduciary, custodial, agency, trust, partnership, or joint venture relationship between Fireblocks and any operator or end user. Fireblocks does not hold, control, or have access to any funds processed by software that you operate on your own infrastructure. Operators bear sole responsibility for any funds, digital assets, or payment flows under their control, and for any obligations to their own end users arising from their deployment of this software.

## 10. x402 protocol

This software implements the x402 open payment protocol specification. The x402 protocol is an open, community-developed standard and is not owned, controlled, or warranted by Fireblocks. The protocol specification may change over time; Fireblocks does not commit to tracking future revisions of the specification and makes no representation that this software will remain compatible with future versions. Other implementations of the x402 protocol are independently developed and maintained; Fireblocks makes no representation as to their security, correctness, or compatibility with this software. Interoperability with third-party x402 implementations is not guaranteed.

---

*This disclaimer is provided for clarity and is not a comprehensive list of risks. Operating payment infrastructure on public blockchains carries inherent risk that you accept by deploying or using this software.*
