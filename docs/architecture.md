# Architecture Overview

This document describes the architecture of the SES Email Forwarder solution.

## Components

1. **Amazon SES (Simple Email Service)**
   - Receives emails for verified domains
   - Triggers actions based on receipt rules
   - Routes emails to S3 storage

2. **S3 Bucket**
   - Stores complete raw email content
   - Provides persistent storage of emails (with 30-day lifecycle policy)
   - Triggers Lambda function via S3 event notifications

3. **Lambda Function**
   - Processes incoming emails from S3 events
   - Retrieves and parses raw email content from S3
   - Applies forwarding rules based on recipient patterns
   - Extracts basic content and identifies attachments for context
   - Formats forwarded emails with the complete original as an attachment

4. **Parameter Store**
   - Stores email forwarding configuration
   - Allows for configuration updates without code changes

5. **IAM Roles and Policies**
   - Provides the necessary permissions for the Lambda function
   - Enables secure access to S3, SES, and Parameter Store

## Flow Diagram

```
  ┌─────────┐         ┌──────────┐         ┌─────────────┐         ┌──────────┐
  │ Incoming│         │   SES    │         │     S3      │         │  Lambda  │
  │  Email  │────────▶│ Receipt  │────────▶│   Bucket    │────────▶│ Function │
  └─────────┘         │  Rules   │         │ (Raw Email) │         └────┬─────┘
                      └──────────┘         └─────────────┘              │
                                                                         │
                                                                         ▼
                                                               ┌───────────────────┐
                                                               │  Parameter Store  │
                                                               │ (Email Mappings)  │
                                                               └─────────┬─────────┘
                                                                         │
                                                                         ▼
                      ┌──────────┐         ┌─────────────┐         ┌──────────┐
                      │ Recipient│         │     SES     │         │ Formatted│
                      │  Inbox   │◀────────│   Sending   │◀────────│ Forwarded│
                      └──────────┘         │             │         │   Email  │
                                           └─────────────┘         └──────────┘
```

## Manual Configuration Required

This solution requires minimal manual configuration after deployment:

1. **SES Receipt Rule Set Activation**: The CDK stack creates the rule set but doesn't automatically set it as active
   - In the SES console, navigate to the rule sets and set the created rule set as active

2. **Email Mappings**: Configure the Parameter Store value with your custom mapping JSON if the default doesn't meet your needs

## Security Considerations

- All data in transit uses HTTPS/TLS
- S3 bucket is configured with encryption and restricted access
- Lambda function has minimal IAM permissions (principle of least privilege)
- Sensitive configuration is stored in Parameter Store with encryption
- SES domain verification ensures only authorized domains are used

## Limitations

- S3 storage provides support for much larger emails than the previous SNS approach
- Lambda has a maximum execution time of 30 seconds, which could be a limitation for very large emails
- Lambda has a payload size limit of 6MB for synchronous invocations

## Scaling

- Lambda function automatically scales based on the number of incoming emails
- S3 bucket provides virtually unlimited storage for email content
- Parameter Store has limits on the size of parameters (4KB for standard, 8KB for advanced)

## Cost Considerations

- Lambda function executions (per request pricing)
- S3 storage and request pricing (storage is usually minimal due to 30-day lifecycle)
- SES receiving and sending emails (per message pricing)
- Parameter Store standard tier (free)