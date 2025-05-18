import { formatForwardedEmail, EmailContent } from '../src/utils/emailUtils';

describe('formatForwardedEmail', () => {
  const testDate = new Date('2023-01-01T12:00:00Z');
  
  const originalEmail: EmailContent = {
    from: 'sender@example.com',
    to: ['recipient@example.com'],
    subject: 'Test Subject',
    textBody: 'This is a test email body.',
    htmlBody: '<div>This is a test email body.</div>',
    headers: {
      'Message-ID': '<test123@example.com>',
      'Date': testDate.toISOString(),
    },
    date: testDate,
  };
  
  test('should format text and HTML email correctly', () => {
    const originalRecipient = 'info@yourdomain.com';
    const forwardTo = 'your-email@example.com';
    
    const formattedEmail = formatForwardedEmail(originalEmail, originalRecipient, forwardTo);
    
    // Check subject line formatting
    expect(formattedEmail.subject).toBe('Fwd: Test Subject');
    
    // Check text body formatting
    expect(formattedEmail.textBody).toContain('From: sender@example.com');
    expect(formattedEmail.textBody).toContain('Subject: Test Subject');
    expect(formattedEmail.textBody).toContain('To: info@yourdomain.com');
    expect(formattedEmail.textBody).toContain('This is a test email body.');
    
    // Check HTML body formatting
    expect(formattedEmail.htmlBody).toContain('<b>From:</b> sender@example.com');
    expect(formattedEmail.htmlBody).toContain('<b>Subject:</b> Test Subject');
    expect(formattedEmail.htmlBody).toContain('<b>To:</b> info@yourdomain.com');
    expect(formattedEmail.htmlBody).toContain('<div>This is a test email body.</div>');
  });
  
  test('should handle emails without HTML body', () => {
    const textOnlyEmail: EmailContent = {
      ...originalEmail,
      htmlBody: undefined,
    };
    
    const formattedEmail = formatForwardedEmail(
      textOnlyEmail, 
      'info@yourdomain.com', 
      'your-email@example.com'
    );
    
    expect(formattedEmail.subject).toBe('Fwd: Test Subject');
    expect(formattedEmail.textBody).toContain('This is a test email body.');
    expect(formattedEmail.htmlBody).toBeUndefined();
  });
});