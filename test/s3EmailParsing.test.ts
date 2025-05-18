import { parseS3Email } from '../src/utils/emailUtils';

describe('parseS3Email', () => {
  // Simple email fixture for testing
  const simpleEmail = `From: sender@example.com
To: recipient@example.com
Subject: Test Email Subject
Date: Mon, 01 Jan 2023 12:00:00 +0000
Content-Type: text/plain; charset=UTF-8

This is a test email body.`;

  // Multipart email fixture for testing
  const multipartEmail = `From: sender@example.com
To: recipient@example.com, another@example.com
Subject: Multipart Test Email
Date: Mon, 01 Jan 2023 12:00:00 +0000
Content-Type: multipart/alternative; boundary="boundary123"

--boundary123
Content-Type: text/plain; charset=UTF-8

This is the plain text version.

--boundary123
Content-Type: text/html; charset=UTF-8

<div>This is the <b>HTML</b> version.</div>

--boundary123--`;

  test('should parse simple text email correctly', () => {
    const emailBuffer = Buffer.from(simpleEmail);
    const parsedEmail = parseS3Email(emailBuffer);

    expect(parsedEmail.from).toBe('sender@example.com');
    expect(parsedEmail.to).toContain('recipient@example.com');
    expect(parsedEmail.subject).toBe('Test Email Subject');
    expect(parsedEmail.textBody).toContain('This is a test email body.');
    expect(parsedEmail.date.toISOString()).toBe(new Date('2023-01-01T12:00:00Z').toISOString());
  });

  test('should parse multipart email correctly', () => {
    const emailBuffer = Buffer.from(multipartEmail);
    const parsedEmail = parseS3Email(emailBuffer);

    expect(parsedEmail.from).toBe('sender@example.com');
    expect(parsedEmail.to).toHaveLength(2);
    expect(parsedEmail.to).toContain('recipient@example.com');
    expect(parsedEmail.to).toContain('another@example.com');
    expect(parsedEmail.subject).toBe('Multipart Test Email');
    expect(parsedEmail.textBody).toContain('This is the plain text version.');
    expect(parsedEmail.htmlBody).toContain('<div>This is the <b>HTML</b> version.</div>');
  });

  test('should use key parts as recipient if no recipients found in email', () => {
    const emailWithoutTo = `From: sender@example.com
Subject: No Recipients
Date: Mon, 01 Jan 2023 12:00:00 +0000
Content-Type: text/plain; charset=UTF-8

This email has no recipients in the headers.`;

    const emailBuffer = Buffer.from(emailWithoutTo);
    const keyParts = ['emails', 'info@example.com', '12345'];
    const parsedEmail = parseS3Email(emailBuffer, keyParts);

    expect(parsedEmail.to).toHaveLength(1);
    expect(parsedEmail.to[0]).toBe('info@example.com');
  });

  test('should handle email with complex "From" header format', () => {
    const emailWithFormattedFrom = `From: "John Doe" <john.doe@example.com>
To: recipient@example.com
Subject: Formatted Headers
Date: Mon, 01 Jan 2023 12:00:00 +0000
Content-Type: text/plain; charset=UTF-8

Test with formatted headers.`;

    const emailBuffer = Buffer.from(emailWithFormattedFrom);
    const parsedEmail = parseS3Email(emailBuffer);

    expect(parsedEmail.from).toBe('"John Doe" <john.doe@example.com>');
    expect(parsedEmail.to[0]).toBe('recipient@example.com');
  });

  test('should provide default values for missing headers', () => {
    const minimalEmail = `Content-Type: text/plain; charset=UTF-8

Just the body, no headers.`;

    const emailBuffer = Buffer.from(minimalEmail);
    const parsedEmail = parseS3Email(emailBuffer);

    expect(parsedEmail.from).toBe('unknown@example.com');
    expect(parsedEmail.subject).toBe('No Subject');
    expect(parsedEmail.textBody).toContain('Just the body, no headers.');
    expect(parsedEmail.to).toHaveLength(0);
    // Date should be close to now
    const now = new Date();
    const parsedDate = parsedEmail.date;
    expect(Math.abs(now.getTime() - parsedDate.getTime())).toBeLessThan(5000); // Within 5 seconds
  });
});