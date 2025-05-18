# SES Email Forwarder

A Lambda-based solution for forwarding emails received by Amazon SES to verified email addresses.

## Overview

This project provides an AWS Lambda function that processes inbound email from Amazon Simple Email Service (SES) and forwards it to configured destination addresses. It's particularly useful for handling emails sent to domains that are not your primary email domain, such as info@yourdomain.com.

Key features:
- Forwards emails received by SES to specified destinations
- Supports wildcard mappings for domains (e.g., *@example.com)
- Properly formats forwarded emails for readability
- Includes attachment information in the forwarded email body
- Preserves the original email as an attachment for reference
- Configurable via AWS Systems Manager Parameter Store
- Comes with a complete CDK deployment stack

## Architecture

[Architecture Diagram](./docs/architecture.md)

The solution works as follows:
1. An email is sent to a verified SES domain (e.g., info@yourdomain.com)
2. SES receives the email and stores the complete email content in an S3 bucket
3. S3 triggers the Lambda function when a new email is stored
4. The Lambda function:
   - Retrieves the email mapping configuration from Parameter Store
   - Retrieves and parses the raw email content from S3
   - Determines the forwarding destination based on the recipient
   - Formats the email as a forwarded message
   - Sends the forwarded email using SES
5. The forwarded email is delivered to the destination address

## Prerequisites

- AWS Account with appropriate permissions
- Node.js v22 or later
- AWS CDK v2
- Domain verified in SES
- SES configured to receive emails for your domain

## Installation

1. Clone this repository:
   ```
   git clone https://github.com/yourusername/ses-forwarder.git
   cd ses-forwarder
   ```

2. Install dependencies:
   ```
   npm install
   ```

3. Build the project:
   ```
   npm run build
   ```

4. Deploy the stack:
   ```
   npx cdk deploy
   ```

## Configuration

### Email Mapping

The mapping between original recipients and forwarding destinations is stored in AWS Systems Manager Parameter Store at `/ses-forwarder/email-mapping`. The parameter contains a JSON object with the following structure:

```json
{
  "*@example.com": "your-email@example.com",
  "info@example.com": "specific-email@example.com",
  "support@example.com": ["support1@example.com", "support2@example.com"]
}
```

Mapping precedence:
1. Exact match (e.g., info@example.com)
2. Domain wildcard (e.g., *@example.com)
3. Subdomain wildcard (e.g., *@*.example.com)
4. Global catch-all (*)

To update the mapping:
```
aws ssm put-parameter --name /ses-forwarder/email-mapping --type String --value '{"*@example.com":"your-email@example.com"}' --overwrite
```

### SES Configuration

After deploying the stack, you need to ensure SES is properly configured:

1. Ensure your domain is verified in SES:
   ```
   aws ses verify-domain-identity --domain example.com
   ```

2. Configure MX records for your domain to point to SES:
   ```
   example.com MX 10 inbound-smtp.us-east-1.amazonaws.com
   ```
   (Replace us-east-1 with your AWS region)

3. In the AWS SES console, navigate to Email Receiving → Rule Sets

4. Find the rule set created by the CDK stack (named "EmailForwardingRules")

5. Set this rule set as active if it's not already active

The CDK stack currently configures a rule with two actions:
- S3 Action: Stores incoming emails in an S3 bucket (with 30-day lifecycle policy)
- Lambda Action: Directly invokes the Lambda function with email metadata

**Important Note**: Our implementation is designed to primarily use the S3 path (the Lambda reads the full email content from S3). The direct Lambda invocation was included as a secondary approach, but you can safely remove it if you prefer a single, consistent flow.

To modify the rule to use only S3:
1. In the SES console, navigate to Email Receiving → Rule Sets → "EmailForwardingRules"
2. Edit the rule and remove the "Lambda" action, keeping only the "S3" action

The S3 event notification will then be the sole trigger for the Lambda function, which is the recommended approach.

> **Note**: This S3-based approach supports emails of all sizes, avoiding the 256KB limit that existed with the previous SNS-based approach

#### Customizing Recipient Conditions

By default, the rule processes all emails to your verified domains. If you want to only forward specific addresses:

1. In the SES console, navigate to Email Receiving → Rule Sets → "EmailForwardingRules"
2. Edit the rule and add recipient conditions (e.g., "info@yourdomain.com", "support@yourdomain.com")
3. Only emails to these addresses will be processed and forwarded

## Testing

Run the automated tests:
```
npm test
```

To manually test the solution:
1. Send an email to an address at your configured domain
2. Check the configured forwarding destination for the forwarded email
3. Verify the formatting and content of the forwarded message

## Limitations

- The Lambda function execution time is limited to 30 seconds
- Very large emails (over 6MB) might hit Lambda payload limits for synchronous invocations
- Both source and destination domains must be verified in SES if you're in the SES sandbox
- You must use SES in a region that supports receiving email (us-east-1, us-west-2, eu-west-1)

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Acknowledgements

- AWS Documentation for [SES](https://docs.aws.amazon.com/ses/latest/dg/receiving-email.html) and [Lambda](https://docs.aws.amazon.com/lambda/latest/dg/welcome.html)
- The AWS CDK team for their excellent infrastructure as code tooling