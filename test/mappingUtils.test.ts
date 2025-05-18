import { findForwardingDestination, parseDestination } from '../src/utils/mappingUtils';

describe('findForwardingDestination', () => {
  const testMapping = {
    'info@example.com': 'admin@example.com',
    '*@example.com': 'catch-all@example.com',
    '*@*.example.com': 'subdomain@example.com',
    '*': 'global-catch-all@example.com',
    'multiple@example.com': ['first@example.com', 'second@example.com']
  };
  
  test('should find exact matches', () => {
    const result = findForwardingDestination('info@example.com', testMapping);
    expect(result).toBe('admin@example.com');
  });
  
  test('should find domain wildcard matches', () => {
    const result = findForwardingDestination('random@example.com', testMapping);
    expect(result).toBe('catch-all@example.com');
  });
  
  test('should find subdomain wildcard matches', () => {
    const result = findForwardingDestination('test@subdomain.example.com', testMapping);
    expect(result).toBe('subdomain@example.com');
  });
  
  test('should find global catch-all matches', () => {
    const result = findForwardingDestination('test@otherdomain.com', testMapping);
    expect(result).toBe('global-catch-all@example.com');
  });
  
  test('should return first element of array destinations', () => {
    const result = findForwardingDestination('multiple@example.com', testMapping);
    expect(result).toBe('first@example.com');
  });
  
  test('should handle invalid email formats', () => {
    const result = findForwardingDestination('invalid-email', testMapping);
    expect(result).toBeUndefined();
  });
});

describe('parseDestination', () => {
  test('should handle string destinations', () => {
    const result = parseDestination('test@example.com');
    expect(result).toEqual(['test@example.com']);
  });
  
  test('should handle array destinations', () => {
    const result = parseDestination(['test1@example.com', 'test2@example.com']);
    expect(result).toEqual(['test1@example.com', 'test2@example.com']);
  });
});