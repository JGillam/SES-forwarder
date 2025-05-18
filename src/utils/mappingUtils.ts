/**
 * Type definition for email mapping configuration
 * Maps original recipient patterns to forwarding destinations
 */
export interface EmailMapping {
  [key: string]: string | string[];
}

/**
 * Find the appropriate forwarding destination for an email recipient
 * based on the configured mappings
 * 
 * @param recipient The original email recipient
 * @param mapping The email mapping configuration
 * @returns The forwarding destination email address or undefined if no match
 */
export function findForwardingDestination(
  recipient: string,
  mapping: EmailMapping
): string | undefined {
  // First check for exact matches
  if (mapping[recipient]) {
    const destination = mapping[recipient];
    return Array.isArray(destination) ? destination[0] : destination;
  }
  
  // Extract domain from recipient
  const recipientDomain = recipient.split('@')[1];
  if (!recipientDomain) {
    console.warn(`Invalid recipient format: ${recipient}`);
    return undefined;
  }
  
  // Check for wildcard matches in descending priority:
  // 1. username@domain.com (exact match - already checked above)
  // 2. *@domain.com (all addresses for specific domain)
  // 3. *@*.domain.com (all subdomains)
  // 4. * (catch-all)
  
  const wildcardDomain = `*@${recipientDomain}`;
  if (mapping[wildcardDomain]) {
    const destination = mapping[wildcardDomain];
    return Array.isArray(destination) ? destination[0] : destination;
  }
  
  // Check for subdomain wildcards if the domain has at least one dot
  if (recipientDomain.includes('.')) {
    const baseDomain = recipientDomain.split('.').slice(-2).join('.');
    const subdomainWildcard = `*@*.${baseDomain}`;
    
    if (mapping[subdomainWildcard]) {
      const destination = mapping[subdomainWildcard];
      return Array.isArray(destination) ? destination[0] : destination;
    }
  }
  
  // Check for catch-all
  if (mapping['*']) {
    const destination = mapping['*'];
    return Array.isArray(destination) ? destination[0] : destination;
  }
  
  // No match found
  return undefined;
}

/**
 * Parse a forwarding destination value from the mapping
 * Handles both string and array formats
 * 
 * @param destination The destination value from the mapping
 * @returns Array of destination email addresses
 */
export function parseDestination(destination: string | string[]): string[] {
  if (Array.isArray(destination)) {
    return destination;
  }
  return [destination];
}