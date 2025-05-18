import { 
  Handler, 
  S3Event
} from 'aws-lambda';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { 
  SESClient, 
  SendEmailCommand, 
  SendRawEmailCommand,
  SendRawEmailCommandInput,
  SendEmailCommandInput, 
  SendEmailCommandOutput 
} from '@aws-sdk/client-ses';
import { 
  S3Client,
  GetObjectCommand 
} from '@aws-sdk/client-s3';
import { 
  formatRawForwardedEmail 
} from '../utils/emailUtils';

// Local implementation of formatForwardedEmail as a fallback
function formatForwardedEmail(
  originalEmail: any,
  originalRecipient: string,
  forwardTo: string
): {
  subject: string;
  textBody?: string;
  htmlBody?: string;
} {
  // Create a formatted subject line
  const subject = `Fwd: ${originalEmail.subject}`;
  
  // Create a formatted text body
  const textBody = `
---------- Forwarded Message ----------
From: ${originalEmail.from}
Date: ${originalEmail.date.toISOString()}
Subject: ${originalEmail.subject}
To: ${originalRecipient}

${originalEmail.textBody || 'No text content available.'}
`;
  
  // Create a formatted HTML body if available
  let htmlBody: string | undefined;
  if (originalEmail.htmlBody) {
    htmlBody = `
<div style="border:1px solid #ccc; padding:10px; margin:10px 0;">
  <div style="border-bottom:1px solid #ccc; padding-bottom:5px; margin-bottom:10px; color:#666;">
    <strong>Forwarded Message</strong><br>
    <strong>From:</strong> ${originalEmail.from}<br>
    <strong>Date:</strong> ${originalEmail.date.toISOString()}<br>
    <strong>Subject:</strong> ${originalEmail.subject}<br>
    <strong>To:</strong> ${originalRecipient}<br>
  </div>
  ${originalEmail.htmlBody}
</div>
`;
  }
  
  return {
    subject,
    textBody,
    htmlBody
  };
}
import { findForwardingDestination } from '../utils/mappingUtils';

// Environment variables
const EMAIL_MAPPING_PARAM = process.env.EMAIL_MAPPING_PARAM || '/ses-forwarder/email-mapping';
const EMAILS_BUCKET = process.env.EMAILS_BUCKET;
const EMAIL_SOURCE = process.env.EMAIL_SOURCE || 'S3'; // Default to S3

// Initialize AWS clients
const ssmClient = new SSMClient({});
const sesClient = new SESClient({});
const s3Client = new S3Client({});

/**
 * Validates that an event is an S3 event
 * @param event The event to check
 * @returns True if the event is a valid S3 event
 */
function validateS3Event(event: S3Event): boolean {
  return !!event.Records && 
         Array.isArray(event.Records) &&
         event.Records.length > 0 &&
         !!event.Records[0].s3 && 
         !!event.Records[0].s3.bucket && 
         !!event.Records[0].s3.object;
}

/**
 * Retrieves the raw email from an S3 bucket
 * @param bucket The S3 bucket name
 * @param key The S3 object key
 * @returns A Buffer containing the email data
 * @throws Error if retrieval fails
 */
async function getEmailFromS3(bucket: string, key: string): Promise<Buffer> {
  console.log(`Retrieving email from S3: ${bucket}/${key}`);
  
  try {
    const response = await s3Client.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
      })
    );
    
    if (!response.Body) {
      throw new Error(`Empty response body from S3 for object: ${bucket}/${key}`);
    }
    
    // Convert stream to buffer
    const chunks: Buffer[] = [];
    for await (const chunk of response.Body as any) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`Error retrieving email from S3 (${bucket}/${key}): ${errorMessage}`);
    throw error;
  }
}

/**
 * Main Lambda handler function for processing email events from S3
 */
export const handler: Handler<S3Event, any> = async (event: S3Event) => {
  console.log('Processing event:', JSON.stringify(event, null, 2));
  
  try {
    // Get the email mapping configuration from SSM Parameter Store
    const mappingParam = await ssmClient.send(
      new GetParameterCommand({
        Name: EMAIL_MAPPING_PARAM,
        WithDecryption: true,
      })
    );
    
    if (!mappingParam.Parameter?.Value) {
      throw new Error(`Unable to retrieve email mapping from ${EMAIL_MAPPING_PARAM}`);
    }
    
    // Safely parse the mapping JSON
    let emailMapping;
    try {
      emailMapping = JSON.parse(mappingParam.Parameter.Value);
      console.log('Loaded email mapping configuration');
    } catch (error) {
      const parseError = error as Error;
      console.error('Error parsing email mapping JSON:', parseError);
      console.log('Raw mapping value:', mappingParam.Parameter.Value);
      throw new Error(`Failed to parse email mapping: ${parseError.message}`);
    }

    // Process S3 event to get email content
    let emailContent;
    let recipients: string[] = [];
    
    // Validate the S3 event
    if (!validateS3Event(event)) {
      throw new Error('Invalid S3 event structure');
    }
      
    console.log('Processing S3 event with email content');
    
    const s3Record = event.Records[0].s3;
    const bucket = s3Record.bucket.name;
    const key = decodeURIComponent(s3Record.object.key.replace(/\+/g, ' '));
    
    // Get the email content from S3
    const emailBuffer = await getEmailFromS3(bucket, key);
    const rawEmail = emailBuffer.toString('utf-8');
    
    // Extract basic recipient info to determine forwarding destinations
    try {
      /**
       * Extract a header value from raw email content
       * @param headerName The name of the header to extract
       * @returns The header value or empty string if not found
       */
      const extractHeaderValue = (headerName: string): string => {
        const regex = new RegExp(`^${headerName}:\s*(.*)$`, 'im');
        const match = rawEmail.match(regex);
        return match && match[1] ? match[1].trim() : '';
      };
      
      /**
       * Extract email addresses from a header value string
       * @param headerValue Header value containing email addresses
       * @returns Array of extracted email addresses
       */
      const extractEmailAddresses = (headerValue: string): string[] => {
        if (!headerValue) return [];
        
        const addresses: string[] = [];
        // Split by commas and extract email addresses
        const headerAddresses = headerValue.split(',');
        headerAddresses.forEach(addr => {
          // Extract email from "Name <email>" format or plain email
          const emailMatch = addr.match(/<([^>]+)>/) || addr.match(/([^\s,]+@[^\s,]+)/);
          if (emailMatch && emailMatch[1]) {
            addresses.push(emailMatch[1].trim());
          }
        });
        return addresses;
      };

      // Extract all potential recipients from To and Cc headers
      const toHeaderValue = extractHeaderValue('To');
      const ccHeaderValue = extractHeaderValue('Cc');
      
      // Combine all recipient addresses
      const extractedRecipients: string[] = [
        ...extractEmailAddresses(toHeaderValue),
        ...extractEmailAddresses(ccHeaderValue)
      ];
      
      // Parse key parts for recipient info (fallback if no recipients found in headers)
      if (extractedRecipients.length === 0) {
        console.log('No recipients found in email headers, trying S3 key parsing fallback');
        const keyParts = key.split('/');
        if (keyParts.length >= 2) {
          const potentialRecipient = keyParts[1];
          if (potentialRecipient.includes('@')) {
            console.log(`Found potential recipient in S3 key: ${potentialRecipient}`);
            extractedRecipients.push(potentialRecipient);
          }
        }
      }
      
      // Use the extracted recipients
      recipients = extractedRecipients;
      
      // Extract essential headers using the helper function
      const fromAddress = extractHeaderValue('From');
      const subject = extractHeaderValue('Subject');
      const dateStr = extractHeaderValue('Date');
      
      // Build a complete headers object for the email
      const headers: Record<string, string> = {};
      
      // List of important headers to extract and preserve
      const headersToExtract = [
        'From', 'To', 'Cc', 'Subject', 'Date', 'Reply-To', 'Message-ID',
        'Content-Type', 'Content-Transfer-Encoding', 'MIME-Version'
      ];
      
      // Extract all important headers
      headersToExtract.forEach(headerName => {
        const value = extractHeaderValue(headerName);
        if (value) {
          headers[headerName] = value;
        }
      });
      
      // Parse date or use current date as fallback
      let emailDate: Date;
      try {
        emailDate = dateStr ? new Date(dateStr) : new Date();
        // Check if the date is valid
        if (isNaN(emailDate.getTime())) {
          throw new Error('Invalid date');
        }
      } catch (error) {
        console.warn(`Could not parse email date: "${dateStr}", using current time instead`);
        emailDate = new Date();
      }
      
      // Create a more complete emailContent object
      emailContent = {
        rawEmail,
        from: fromAddress,
        to: recipients,
        subject: subject,
        textBody: '', // Not needed for raw forwarding
        htmlBody: '', // Not needed for raw forwarding
        headers,
        date: emailDate
      };
      
      if (recipients.length === 0) {
        console.log('No recipients extracted from email headers or S3 key, unable to determine forwarding destination');
      }
    } catch (error) {
      console.error('Error processing email from S3:', error);
      throw error;
    }
    
    // Skip further processing if we have no email content or recipients
    if (!emailContent || recipients.length === 0) {
      console.log('No email content or recipients found, skipping forwarding');
      return [];
    }
    
    console.log(`Processing message for ${recipients.length} recipients:`, recipients);
    
    // For each recipient, find the forwarding destination and send the email
    // Use Promise.allSettled to prevent one failure from stopping the entire batch
    const forwardingPromises = recipients.map(async (recipient) => {
      // Determine the forwarding destination based on the mapping
      const forwardTo = findForwardingDestination(recipient, emailMapping);
      
      if (!forwardTo) {
        console.log(`No forwarding destination found for ${recipient}, skipping`);
        return {
          status: 'skipped',
          recipient,
          reason: 'No forwarding destination found'
        };
      }
      
      console.log(`Forwarding email from ${recipient} to ${forwardTo}`);
      
      try {
        let result;
        
        // Check if we have raw email content available (from S3)
        if (emailContent.rawEmail) {
          console.log('Using raw email forwarding approach for complete email content');
          
          // Format the raw email for forwarding
          const formattedRawEmail = formatRawForwardedEmail(
            emailContent.rawEmail,
            recipient,
            forwardTo
          );
          
          // Send the raw email
          // Note: We don't need to specify Reply-To separately here
          // since it's already included in the raw email headers
          const rawParams: SendRawEmailCommandInput = {
            Source: recipient,
            Destinations: [forwardTo],
            RawMessage: {
              Data: Buffer.from(formattedRawEmail)
            }
          };
          
          result = await sesClient.send(new SendRawEmailCommand(rawParams));
          console.log('Successfully sent raw forwarded email with attachments preserved');
        } else {
          // Fallback to the regular email format without attachments
          console.log('Using standard email forwarding approach');
          
          // Format the email as a forwarded message
          const formattedEmail = formatForwardedEmail(emailContent, recipient, forwardTo);
          
          // Extract the reply-to or use the from address of the original email
          const replyTo = emailContent.headers['Reply-To'] || 
                         emailContent.headers['reply-to'] || 
                         emailContent.from;

          // Send the forwarded email
          const params: SendEmailCommandInput = {
            Source: recipient, // Using the original recipient as the sender
            Destination: {
              ToAddresses: [forwardTo],
            },
            ReplyToAddresses: [replyTo], // Add reply-to header for non-raw emails
            Message: {
              Subject: {
                Data: formattedEmail.subject,
                Charset: 'UTF-8',
              },
              Body: {
                Text: {
                  Data: formattedEmail.textBody || 'Email content is not available in text format.',
                  Charset: 'UTF-8',
                },
                Html: {
                  Data: formattedEmail.htmlBody || formattedEmail.textBody || 
                        '<p>Email content is not available in text format.</p>',
                  Charset: 'UTF-8',
                },
              },
            },
          };
          
          result = await sesClient.send(new SendEmailCommand(params));
        }
        
        console.log(`Email forwarded successfully to ${forwardTo}`, result.MessageId);
        return {
          status: 'success',
          recipient,
          destination: forwardTo,
          messageId: result.MessageId
        };
      } catch (sendError) {
        const errorMessage = sendError instanceof Error ? sendError.message : 'Unknown error';
        console.error(`Error forwarding email to ${forwardTo}: ${errorMessage}`);
        // Return error information instead of throwing to prevent Promise.allSettled from failing
        return {
          status: 'error',
          recipient,
          destination: forwardTo,
          error: errorMessage
        };
      }
    });
    
    // Use Promise.allSettled to handle both successful and failed operations
    const results = await Promise.allSettled(forwardingPromises);
    
    // Summarize results
    const summary = {
      total: results.length,
      fulfilled: results.filter(r => r.status === 'fulfilled').length,
      rejected: results.filter(r => r.status === 'rejected').length,
      successful: results.filter(r => r.status === 'fulfilled' && r.value.status === 'success').length,
      skipped: results.filter(r => r.status === 'fulfilled' && r.value.status === 'skipped').length,
      failed: results.filter(r => r.status === 'fulfilled' && r.value.status === 'error').length
    };
    
    console.log('Finished processing all messages with summary:', summary);
    
    // Extract and return the results
    const processedResults = results.map(r => r.status === 'fulfilled' ? r.value : { status: 'rejected', reason: r.reason });
    return processedResults;
  } catch (error) {
    console.error('Error processing event:', error);
    throw error;
  }
};