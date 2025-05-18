import { S3Event } from 'aws-lambda';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { Readable } from 'stream';

// Initialize S3 client
const s3Client = new S3Client({});

/**
 * Helper function to decode quoted-printable content
 * @param content The quoted-printable encoded content
 * @returns The decoded content
 */
function decodeQuotedPrintable(content: string): string {
  // Handle equals sign followed by two hex digits
  let decoded = content.replace(/=([0-9A-F]{2})/g, (match, hexChars) => {
    return String.fromCharCode(parseInt(hexChars, 16));
  });
  
  // Handle soft line breaks (equals sign at end of line)
  decoded = decoded.replace(/=\r\n/g, '').replace(/=\n/g, '');
  
  return decoded;
}

// Email content interface
export interface EmailContent {
  from: string;
  to: string[];
  cc?: string[];
  subject: string;
  textBody?: string;
  htmlBody?: string;
  attachments?: Attachment[];
  headers: Record<string, string>;
  date: Date;
  rawEmail?: string; // Raw email content for direct forwarding
}

// Email attachment interface
export interface Attachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

// Formatted email for forwarding
export interface FormattedEmail {
  subject: string;
  textBody?: string;
  htmlBody?: string;
  attachments?: Attachment[];
}

// Email-related types and utility functions follow

// formatForwardedEmail has been moved to index.ts as a local implementation

/**
 * Parse email data directly from an S3 stored email
 * @param emailBuffer Raw email data from S3
 * @param keyParts Optional parts of the S3 key that might contain metadata
 */
export function parseS3Email(emailBuffer: Buffer, keyParts?: string[]): EmailContent {
  console.log('Parsing email from raw S3 content');
  
  // Convert the buffer to a string
  const rawEmail = emailBuffer.toString('utf-8');
  
  // Basic email parsing
  // In a production implementation, you'd use a library like mailparser
  // This is a simplified version for demonstration
  
  // Extract headers
  const headers: Record<string, string> = {};
  const headerMatch = rawEmail.match(/^(.*?)\r?\n\r?\n/s);
  
  if (headerMatch && headerMatch[1]) {
    // Parse common headers
    const headerText = headerMatch[1];
    const headerLines = headerText.split(/\r?\n/);
    
    // Process header lines (handling continuation lines)
    let currentHeader = '';
    let currentValue = '';
    
    for (const line of headerLines) {
      // Check if this is a continuation line (starts with whitespace)
      if (/^\s+/.test(line)) {
        currentValue += ' ' + line.trim();
      } else {
        // If we have a header in progress, save it
        if (currentHeader) {
          headers[currentHeader] = currentValue;
        }
        
        // Start a new header
        const match = line.match(/^([^:]+):\s*(.*)/);
        if (match) {
          currentHeader = match[1];
          currentValue = match[2];
        }
      }
    }
    
    // Save the last header
    if (currentHeader) {
      headers[currentHeader] = currentValue;
    }
  }
  
  // Try to extract basic email components
  const from = headers['From'] || headers['from'] || 'unknown@example.com';
  const subject = headers['Subject'] || headers['subject'] || 'No Subject';
  let toHeader = headers['To'] || headers['to'] || '';
  
  // Parse To header into array of recipients
  const toAddresses: string[] = [];
  if (toHeader) {
    // Handle comma-separated addresses
    toHeader.split(',').forEach(addr => {
      // Extract email from "Name <email>" format
      const emailMatch = addr.match(/<([^>]+)>/) || addr.match(/([^\s]+@[^\s]+)/);
      if (emailMatch && emailMatch[1]) {
        toAddresses.push(emailMatch[1].trim());
      } else {
        toAddresses.push(addr.trim());
      }
    });
  }
  
  // If we couldn't extract recipients from headers, try to use the S3 key parts
  if (toAddresses.length === 0 && keyParts && keyParts.length >= 2) {
    const potentialRecipient = keyParts[1];
    if (potentialRecipient.includes('@')) {
      toAddresses.push(potentialRecipient);
    }
  }
  
  // Extract date
  let date = new Date();
  if (headers['Date'] || headers['date']) {
    try {
      date = new Date(headers['Date'] || headers['date'] || '');
    } catch (error) {
      console.warn('Could not parse email date, using current time');
    }
  }
  
  // Extract content parts
  let textBody = '';
  let htmlBody = '';
  const attachments: Attachment[] = [];
  
  console.log('Beginning to parse email content...');
  
  // Helper function to decode quoted-printable content
  function decodeQuotedPrintable(content: string): string {
    // Handle equals sign followed by two hex digits
    let decoded = content.replace(/=([0-9A-F]{2})/g, (match, hexChars) => {
      return String.fromCharCode(parseInt(hexChars, 16));
    });
    
    // Handle soft line breaks (equals sign at end of line)
    decoded = decoded.replace(/=\r\n/g, '').replace(/=\n/g, '');
    
    return decoded;
  }
  
  // Helper function to decode base64 content
  function decodeBase64(content: string): Buffer {
    // Remove any whitespace from the base64 string
    const cleanedContent = content.replace(/\s/g, '');
    return Buffer.from(cleanedContent, 'base64');
  }
  
  // Helper function to extract content disposition information
  function extractContentDisposition(part: string): { filename?: string, isAttachment: boolean } {
    const result = { 
      filename: undefined as string | undefined, 
      isAttachment: false 
    };
    
    const contentDispositionMatch = part.match(/Content-Disposition:([^\r\n]*)/i);
    if (contentDispositionMatch) {
      const contentDisposition = contentDispositionMatch[1].toLowerCase();
      
      // Check if it's an attachment
      result.isAttachment = contentDisposition.includes('attachment');
      
      // Extract filename if available
      const filenameMatch = part.match(/filename="([^"]+)"/i) || part.match(/filename=([^\s;]+)/i);
      if (filenameMatch) {
        result.filename = filenameMatch[1];
      }
    }
    
    return result;
  }
  
  // Find the main content type and boundary
  const contentTypeMatch = rawEmail.match(/Content-Type:\s*([^;\r\n]+)(?:;[\s\S]*?boundary="([^"]+)")?/i);
  const mainContentType = contentTypeMatch ? contentTypeMatch[1].trim().toLowerCase() : 'text/plain';
  const mainBoundary = contentTypeMatch && contentTypeMatch[2] ? contentTypeMatch[2] : null;
  
  console.log(`Main content type: ${mainContentType}, has boundary: ${mainBoundary !== null}`);
  
  if (mainBoundary) {
    // Multipart email
    const parts = rawEmail.split(`--${mainBoundary}`);
    
    // Process each part
    for (const part of parts) {
      if (part.trim().length === 0 || part.trim() === '--') continue;
      
      // Check for nested multipart content
      const nestedBoundaryMatch = part.match(/Content-Type:[^\n]*boundary="([^"]+)"/i);
      if (nestedBoundaryMatch) {
        const nestedBoundary = nestedBoundaryMatch[1];
        const nestedParts = part.split(`--${nestedBoundary}`);
        
        // Process nested parts
        for (const nestedPart of nestedParts) {
          if (nestedPart.trim().length === 0 || nestedPart.trim() === '--') continue;
          
          // Process this nested part
          processPart(nestedPart);
        }
      } else {
        // Process regular part
        processPart(part);
      }
    }
  } else {
    // Not a multipart email, treat the whole body as content
    const contentMatch = rawEmail.match(/\r?\n\r?\n([\s\S]*)/);
    if (contentMatch && contentMatch[1]) {
      const content = contentMatch[1].trim();
      
      if (mainContentType === 'text/plain') {
        textBody = content;
        
        // Check if it's encoded
        if (rawEmail.match(/Content-Transfer-Encoding:\s*quoted-printable/i)) {
          textBody = decodeQuotedPrintable(textBody);
        }
      } else if (mainContentType === 'text/html') {
        htmlBody = content;
        
        // Check if it's encoded
        if (rawEmail.match(/Content-Transfer-Encoding:\s*quoted-printable/i)) {
          htmlBody = decodeQuotedPrintable(htmlBody);
        }
      }
    }
  }
  
  // Helper function to process an individual email part
  function processPart(part: string) {
    // Extract content type
    const contentTypeMatch = part.match(/Content-Type:\s*([^;\r\n]+)/i);
    const contentType = contentTypeMatch ? contentTypeMatch[1].trim().toLowerCase() : 'text/plain';
    
    // Check transfer encoding
    const encodingMatch = part.match(/Content-Transfer-Encoding:\s*([^\r\n]+)/i);
    const encoding = encodingMatch ? encodingMatch[1].trim().toLowerCase() : 'binary';
    
    // Check content disposition (attachment vs inline)
    const { filename, isAttachment } = extractContentDisposition(part);
    
    // Extract content
    const contentMatch = part.match(/\r?\n\r?\n([\s\S]*?)(?:\r?\n\r?\n|$)/);
    if (!contentMatch || !contentMatch[1]) return;
    
    let content = contentMatch[1].trim();
    
    // Handle based on content type and encoding
    if (contentType.startsWith('text/plain') && !isAttachment) {
      if (encoding === 'quoted-printable') {
        content = decodeQuotedPrintable(content);
      } else if (encoding === 'base64') {
        content = decodeBase64(content).toString('utf-8');
      }
      
      // Append to text body if not empty
      if (content.trim().length > 0) {
        textBody = textBody ? `${textBody}\n\n${content}` : content;
      }
    } else if (contentType.startsWith('text/html') && !isAttachment) {
      if (encoding === 'quoted-printable') {
        content = decodeQuotedPrintable(content);
      } else if (encoding === 'base64') {
        content = decodeBase64(content).toString('utf-8');
      }
      
      // Append to HTML body if not empty
      if (content.trim().length > 0) {
        htmlBody = htmlBody ? `${htmlBody}\n${content}` : content;
      }
    } else if (isAttachment || contentType.startsWith('image/') || 
               filename || contentType.includes('application/')) {
      // Handle attachment
      try {
        let attachmentContent: Buffer;
        
        if (encoding === 'base64') {
          attachmentContent = decodeBase64(content);
        } else if (encoding === 'quoted-printable') {
          attachmentContent = Buffer.from(decodeQuotedPrintable(content));
        } else {
          attachmentContent = Buffer.from(content);
        }
        
        const attachmentName = filename || `attachment-${attachments.length + 1}`;
        const attachmentType = contentType || 'application/octet-stream';
        
        attachments.push({
          filename: attachmentName,
          content: attachmentContent,
          contentType: attachmentType
        });
        
        console.log(`Parsed attachment: ${attachmentName}, type: ${attachmentType}, size: ${attachmentContent.length} bytes`);
        
        // For images referenced in HTML, we can also ensure they're properly handled
        if (contentType.startsWith('image/') && htmlBody) {
          // If this is an inline image that might be referenced in the HTML
          const contentId = part.match(/Content-ID:\s*<([^>]+)>/i);
          if (contentId) {
            // The image might be referenced in the HTML as cid:content-id
            const cid = contentId[1];
            console.log(`Found image with Content-ID: ${cid}`);
          }
        }
      } catch (error) {
        console.error('Error processing attachment:', error);
      }
    }
  }
  
  console.log(`Finished parsing email. Text body length: ${textBody.length}, HTML body length: ${htmlBody.length}, Attachments: ${attachments.length}`);
  
  return {
    from,
    to: toAddresses,
    subject,
    textBody,
    htmlBody,
    attachments: attachments.length > 0 ? attachments : undefined,
    headers,
    date
  };
}

/**
 * Format an email as a forwarded message in raw format for SendRawEmail
 * This approach extracts the text content for immediate readability while
 * also including the complete original message as an attachment
 * 
 * @param rawEmail The original raw email content as a string
 * @param originalRecipient The original recipient email address
 * @param forwardTo The destination email address to forward to
 * @returns Formatted raw email ready for SendRawEmail
 */
export function formatRawForwardedEmail(
  rawEmail: string,
  originalRecipient: string,
  forwardTo: string
): string {
  // Parse basic header information to create a proper forward subject
  const subjectMatch = rawEmail.match(/^Subject:\s*(.*)$/im);
  const originalSubject = subjectMatch ? subjectMatch[1].trim() : 'No Subject';
  const fromMatch = rawEmail.match(/^From:\s*(.*)$/im);
  const originalFrom = fromMatch ? fromMatch[1].trim() : 'unknown@example.com';
  const dateMatch = rawEmail.match(/^Date:\s*(.*)$/im);
  const originalDate = dateMatch ? dateMatch[1].trim() : new Date().toUTCString();
  
  // Extract text content from the email if possible
  let extractedText = 'Original message content could not be parsed.';
  let extractedHtml = '';
  let foundTextPart = false;
  let foundHtmlPart = false;
  
  // Try to extract the text content based on content type
  // More robust boundary extraction
  let contentType = null;
  let boundary = null;
  
  // Find the Content-Type header and boundary
  const contentTypeMatch = rawEmail.match(/Content-Type:\s*([^;\r\n]+)(?:;[\s\S]*?)?/im);
  if (contentTypeMatch) {
    contentType = contentTypeMatch[1].trim().toLowerCase();
    
    // Look for the boundary parameter specifically
    const boundaryMatch = rawEmail.match(/boundary=["']?([^"';\r\n]+)["']?/im);
    if (boundaryMatch) {
      boundary = boundaryMatch[1].trim();
      console.log(`Found boundary: ${boundary}`);
    }
  }
  
  // Find any attachments in the email
  const attachmentNames: string[] = [];
  const attachmentPattern = /Content-Disposition:\s*attachment;\s*filename=["']?([^"'\r\n;]+)["']?/gi;
  let attachmentMatch;
  
  while ((attachmentMatch = attachmentPattern.exec(rawEmail)) !== null) {
    if (attachmentMatch[1]) {
      attachmentNames.push(attachmentMatch[1].trim());
    }
  }
  
  // Also check alternative pattern that some email clients use
  const altAttachmentPattern = /Content-Type:[^\r\n]+name=["']?([^"'\r\n;]+)["']?/gi;
  while ((attachmentMatch = altAttachmentPattern.exec(rawEmail)) !== null) {
    // Only add if it looks like an attachment filename
    const filename = attachmentMatch[1].trim();
    if (filename.includes('.') && !attachmentNames.includes(filename)) {
      attachmentNames.push(filename);
    }
  }
  
  if (attachmentNames.length > 0) {
    console.log(`Found ${attachmentNames.length} attachments: ${attachmentNames.join(', ')}`);
  }
  
  // Simple content extraction for common email patterns
  // This is a shortcut to get basic text content from common email structures
  const textContentMatch = rawEmail.match(/Content-Type:\s*text\/plain[\s\S]*?\r?\n\r?\n([\s\S]*?)(?:\r?\n\-\-|\r?\n\r?\nContent-Type:)/i);
  if (textContentMatch && textContentMatch[1]) {
    let textContent = textContentMatch[1].trim();
    
    // Check for encoding
    const encodingMatch = rawEmail.match(/Content-Transfer-Encoding:\s*([^\r\n]+)/i);
    const encoding = encodingMatch ? encodingMatch[1].trim().toLowerCase() : 'none';
    
    if (encoding === 'quoted-printable') {
      extractedText = decodeQuotedPrintable(textContent);
    } else if (encoding === 'base64') {
      try {
        extractedText = Buffer.from(textContent.replace(/\s/g, ''), 'base64').toString('utf-8');
      } catch (e) {
        console.error('Error decoding base64 content:', e);
        extractedText = textContent;
      }
    } else {
      extractedText = textContent;
    }
    
    // Add attachment information to the extracted text
    if (attachmentNames.length > 0) {
      extractedText += '\n\n----- Attachments -----';
      attachmentNames.forEach(attachment => {
        extractedText += `\n[ATTACHMENT: ${attachment}]`;
      });
    }
    
    foundTextPart = true;
    console.log('Found text content using simple pattern match');
  } else if (attachmentNames.length > 0) {
    // If we couldn't find text content but we found attachments, at least mention them
    extractedText = 'Email content could not be extracted.\n\n----- Attachments -----';
    attachmentNames.forEach(attachment => {
      extractedText += `\n[ATTACHMENT: ${attachment}]`;
    });
  }
  
  if (contentType) {
    console.log(`Original email content type: ${contentType}`);
    
    // Handle different content types to extract text
    if (contentType.startsWith('text/plain') && !foundTextPart) {
      // Simple plain text email
      console.log('Processing simple text/plain email');
      const textMatch = rawEmail.match(/\r?\n\r?\n([\s\S]*?)$/);
      if (textMatch && textMatch[1]) {
        extractedText = textMatch[1].trim();
      }
    } else if (contentType.startsWith('text/html')) {
      // HTML-only email
      const htmlMatch = rawEmail.match(/\r?\n\r?\n([\s\S]*?)$/);
      if (htmlMatch && htmlMatch[1]) {
        extractedHtml = htmlMatch[1].trim();
        extractedText = 'This email contains HTML content. See attachment for complete message.';
      }
    } else if (contentType.startsWith('multipart/') && boundary) {
      console.log(`Processing multipart email with boundary: ${boundary}`);
      
      try {
        // Multipart email - split by the full boundary pattern
        const boundaryPattern = `--${boundary}`;
        const endBoundaryPattern = `--${boundary}--`;
        
        // Split the email into parts using the boundary
        let parts: string[] = [];
        let emailBody = '';
        
        // First, split headers and body to focus on the body part
        const headerBodySplit = rawEmail.split(/\r?\n\r?\n/, 2);
        if (headerBodySplit.length > 1) {
          emailBody = headerBodySplit[1];
          
          // Try multiple boundary pattern matching approaches
          // 1. Standard boundary pattern
          parts = emailBody.split(new RegExp(boundaryPattern, 'g'));
          
          // Log the number of parts found
          console.log(`Found ${parts.length} parts in multipart email with standard boundary pattern`);
          
          // 2. If standard approach yields few results, try with CRLF
          if (parts.length <= 1) {
            console.log('Few parts found with standard boundary pattern, trying with CRLF prefix');
            parts = emailBody.split(new RegExp(`\r?\n${boundaryPattern}`, 'g'));
            console.log(`Second attempt: Found ${parts.length} parts in multipart email`);
          }
          
          // Process each part with simplified approach
          for (let i = 0; i < parts.length; i++) {
            const part = parts[i].trim();
            if (!part || part === endBoundaryPattern) continue;
            
            // Extract content type and encoding for this part
            const partTypeMatch = part.match(/Content-Type:\s*([^;\r\n]+)/i);
            if (!partTypeMatch) continue;
            
            const partContentType = partTypeMatch[1].trim().toLowerCase();
            const encodingMatch = part.match(/Content-Transfer-Encoding:\s*([^\r\n]+)/i);
            const encoding = encodingMatch ? encodingMatch[1].trim().toLowerCase() : 'none';
            
            // Extract the content part (after the blank line)
            const contentMatch = part.split(/\r?\n\r?\n/, 2);
            if (contentMatch.length < 2) continue;
            
            const content = contentMatch[1].trim();
            
            // Simple extraction based on content type - no need for deep parsing
            if (partContentType === 'text/plain' && !foundTextPart) {
              foundTextPart = true;
              console.log('Found text/plain part, extracting content');
              
              // Basic decoding
              try {
                if (encoding === 'quoted-printable') {
                  extractedText = decodeQuotedPrintable(content);
                } else if (encoding === 'base64') {
                  extractedText = Buffer.from(content.replace(/\s/g, ''), 'base64').toString('utf-8');
                } else {
                  extractedText = content;
                }
              } catch (e) {
                console.error('Error extracting text:', e);
                extractedText = 'Text content extraction error';
              }
            } 
            else if (partContentType === 'text/html' && !foundHtmlPart) {
              foundHtmlPart = true;
              console.log('Found text/html part, extracting content');
              
              // Basic decoding
              try {
                if (encoding === 'quoted-printable') {
                  extractedHtml = decodeQuotedPrintable(content);
                } else if (encoding === 'base64') {
                  extractedHtml = Buffer.from(content.replace(/\s/g, ''), 'base64').toString('utf-8');
                } else {
                  extractedHtml = content;
                }
              } catch (e) {
                console.error('Error extracting HTML:', e);
              }
            }
          }
        }
        // Handle multipart sections with simplified approach - no need for deep nesting
        else if (contentType.startsWith('multipart/')) {
          console.log('Found multipart content, but using simplified parsing');
          // Since we're using the raw email approach, detailed parsing isn't critical
        }
      } catch (e) {
        console.error('Error processing multipart email:', e);
        extractedText = 'Error parsing email content. See attachment for complete message.';
      }
      
      // Check if we found any content
      if (extractedText === 'Original message content could not be parsed.' && !extractedHtml) {
        extractedText = 'Email content could not be extracted. See attachment for complete message.';
        console.log('Failed to extract any content from multipart email');
      } else {
        console.log(`Successfully extracted content. Text length: ${extractedText.length}, HTML present: ${extractedHtml.length > 0}`);
      }
    }
  }
  
  // Helper function to decode quoted-printable content
  function decodeQuotedPrintable(content: string): string {
    // Handle equals sign followed by two hex digits
    let decoded = content.replace(/=([0-9A-F]{2})/g, (match, hexChars) => {
      return String.fromCharCode(parseInt(hexChars, 16));
    });
    
    // Handle soft line breaks (equals sign at end of line)
    decoded = decoded.replace(/=\r\n/g, '').replace(/=\n/g, '');
    
    return decoded;
  }
  
  // Create a unique boundary string for the multipart message
  const newBoundary = `----=_ForwardBoundary_${Math.random().toString(36).substr(2, 9)}`;
  const altBoundary = `----=_AltBoundary_${Math.random().toString(36).substr(2, 9)}`;
  
  // Determine if we have HTML content to include
  const hasHtml = extractedHtml.length > 0;
  
  // Extract the reply-to or use the from address
  const replyToMatch = rawEmail.match(/^Reply-To:\s*(.*)$/im);
  const replyTo = replyToMatch ? replyToMatch[1].trim() : originalFrom;
  
  // Create the main headers and initial parts
  let forwardedEmail = [
    `From: ${originalRecipient}`,
    `To: ${forwardTo}`,
    `Reply-To: ${replyTo}`,
    `Subject: Fwd: ${originalSubject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${newBoundary}"`,
    '',
    `--${newBoundary}`
  ].join('\r\n');
  
  // Add the message content part (text or alternative)
  if (hasHtml) {
    // If we have HTML, create a multipart/alternative section
    forwardedEmail += `
Content-Type: multipart/alternative; boundary="${altBoundary}"

--${altBoundary}
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 7bit

---------- Forwarded message ---------
From: ${originalFrom}
Date: ${originalDate}
Subject: ${originalSubject}
To: ${originalRecipient}

${extractedText}

Note: The complete original message is attached for reference.

--${altBoundary}
Content-Type: text/html; charset=UTF-8
Content-Transfer-Encoding: 7bit

<div style="border-top:1px solid #ccc; margin-top:20px; padding-top:10px;">
  <p><b>---------- Forwarded message ---------</b><br>
  <b>From:</b> ${originalFrom}<br>
  <b>Date:</b> ${originalDate}<br>
  <b>Subject:</b> ${originalSubject}<br>
  <b>To:</b> ${originalRecipient}</p>
</div>

${extractedHtml}

<p style="color: #555; font-style: italic; margin-top: 20px; border-top: 1px solid #eee; padding-top: 10px;">
  Note: The complete original message is attached for reference.
</p>

--${altBoundary}--`;
  } else {
    // Simple plain text only
    forwardedEmail += `
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 7bit

---------- Forwarded message ---------
From: ${originalFrom}
Date: ${originalDate}
Subject: ${originalSubject}
To: ${originalRecipient}

${extractedText}

Note: The complete original message is attached for reference.`;
  }
  
  // Add the original message as an attachment
  forwardedEmail += `

--${newBoundary}
Content-Type: message/rfc822
Content-Disposition: attachment; filename="original_message.eml"

${rawEmail}

--${newBoundary}--`;
  
  return forwardedEmail;
}

// formatForwardedEmail function is now implemented locally in index.ts
// This helps avoid duplication and simplifies maintenance