/**
 * Generate random IDs in Stripe format: {prefix}_{randomChars}
 * Total length is always 12 characters (including prefix and underscore)
 * Uses cryptographically secure randomness (Node.js crypto module)
 *
 * @example
 * randId('prod') // => 'prod_8DfEdd8'
 * randId('pay')  // => 'pay_9Kx2mPq4'
 * randId('cus')  // => 'cus_7Lm3nOp5'
 */

import { randomBytes } from "crypto";

const CHARSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/**
 * Generate a cryptographically secure random ID with the given prefix
 * @param prefix - The prefix for the ID (e.g., 'prod', 'pay', 'cus')
 * @returns A 12-character ID in the format {prefix}_{randomChars}
 */
export function randId(prefix: string): string {
	// Total length is 12, minus prefix length and underscore
	const randomLength = 18 - prefix.length - 1;

	if (randomLength <= 0) {
		throw new Error(`Prefix "${prefix}" is too long. Maximum prefix length is 10 characters.`);
	}

	let randomChars = "";
	const bytes = randomBytes(randomLength);

	for (let i = 0; i < randomLength; i++) {
		const randomIndex = bytes[i] % CHARSET.length;
		randomChars += CHARSET[randomIndex];
	}

	return `${prefix}_${randomChars}`;
}
