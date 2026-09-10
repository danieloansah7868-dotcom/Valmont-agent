/**
 * The payment method string stamped on agent wallet orders (Stage 7b).
 *
 * This leaf module is the ONLY definition. The agent buy route stamps it
 * onto an order, `settleAgentOrder` recognises it, the merchant new-order
 * alert words it, the owner's refund-to-wallet route gates on it, the
 * manage pages badge on it, and `paymentMethodLabel` maps it to a display
 * name. Any second hardcoded copy could drift from this one — a recogniser
 * that missed a wallet order would skip settling, mislabel it, or offer the
 * wrong actions — so every consumer reads this constant.
 *
 * It lives in its own leaf on purpose: importing a shared constant from a
 * module that also owns database stores (studio/orders) couples every
 * consumer to that module's machinery, and to its test doubles. A constant
 * that decides how money is labelled and settled must cost nothing to
 * import.
 *
 * It is deliberately NOT in PAYMENT_METHODS (site-brief schema), which is
 * what keeps "agent_wallet" unselectable in Studio → Payments and
 * unacceptable at the public checkout.
 */
export const AGENT_WALLET_PAYMENT_METHOD = "agent_wallet" as const;
