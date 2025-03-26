# AWS Leave Management System

The AWS Leave Management System is a serverless application designed to streamline the process of applying for and approving leave requests within an organization. Leveraging the power of AWS services, this system provides a scalable, reliable, and secure solution for managing employee leave.

## Features

- **Secure Authentication**: Uses JWT tokens to ensure only authorized users can submit leave requests.
- **RESTful API**: Allows easy leave application submission through a simple HTTP endpoint.
- **Automated Workflow**: Implements an approval process with email notifications powered by AWS Step Functions.
- **Persistent Storage**: Stores leave requests securely in Amazon DynamoDB.
- **Email Integration**: Sends notifications and approval requests via Amazon SES.
- **Scalable Design**: Built with serverless AWS components for reliability and scalability.

## Architecture

The system follows a microservices architecture, with each component serving a distinct purpose:

- **API Gateway**: Acts as the entry point, handling incoming HTTP requests and routing them to appropriate Lambda functions.
- **Lambda Functions**:
  - `authorizer`: Validates JWT tokens to authenticate users.
  - `applyLeave`: Processes leave applications, stores them in DynamoDB, and triggers the approval workflow.
  - `sendApproval`: Sends an email to the approver with links to approve or reject the request.
  - `processApproval`: Updates the workflow based on the approver’s decision.
  - `notifyUser`: Emails the user with the final decision.
- **DynamoDB**: Provides persistent storage for leave request data.
- **SES (Simple Email Service)**: Manages email communications for approvals and notifications.
- **Step Functions**: Orchestrates the approval workflow, ensuring each step executes in sequence.

### Workflow

1. A user submits a leave request via a POST request to the API Gateway.
2. The `authorizer` Lambda verifies the JWT token.
3. If authenticated, the `applyLeave` Lambda stores the request in DynamoDB and starts a Step Function execution.
4. The Step Function triggers the `sendApproval` Lambda, which emails the approver with approval/rejection links.
5. The approver clicks a link, invoking the `processApproval` Lambda to update the workflow.
6. The Step Function then calls the `notifyUser` Lambda to email the user with the outcome.

## Prerequisites

Before setting up the project, ensure you have the following:

- An AWS account with permissions to create resources (e.g., Lambda, API Gateway, DynamoDB, SES, Step Functions).
- [SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/serverless-sam-cli-install.html) installed for deployment.
- [Node.js](https://nodejs.org/) installed (optional, for local Lambda testing).
- A verified email address in Amazon SES for sending emails (set in `template.yaml` or configured separately).

## Installation

Follow these steps to deploy the application:

1. **Clone the Repository**:

   ```bash
   git clone https://github.com/ashwindilip/aws-leave-management.git
   ```

2. **Navigate to the Project Directory**:

   ```bash
   cd aws-leave-management
   ```

3. **Install Dependencies**:

   ```bash
   npm install
   ```

   This installs the required Node.js packages specified in `package.json`.

4. **Deploy the Application**:
   ```bash
   sam deploy
   ```
   After deployment, note the API Gateway endpoint URL from the SAM output for interacting with the system.

## Usage

### Applying for Leave

To submit a leave request, send a POST request to the `/apply-leave` endpoint with a valid JWT token and the required fields:

```bash
curl -X POST https://your-api-id.execute-api.your-region.amazonaws.com/Prod/apply-leave \
-H "Authorization: Bearer your-jwt-token" \
-H "Content-Type: application/json" \
-d '{
  "leaveType": "Vacation",
  "startDate": "2023-07-01",
  "endDate": "2023-07-05",
  "approverEmail": "approver@example.com",
  "reason": "Family vacation"
}'
```

### Approval Process

1. The approver receives an email with links to approve or reject the request.
2. Clicking a link updates the request status, and the user is notified of the outcome via email.

## Configuration

The application uses the following environment variables:

- **`JWT_SECRET`**: Secret key for JWT verification (set using `parameter_overrides` in `samconfig.toml`).
- **`SES_EMAIL`**: Sender email address for SES (defined in `template.yaml`, e.g., `ashwin.dilip@antstack.io`—update if needed).
- **`TABLE_NAME`**: DynamoDB table name (auto-set by SAM).
- **`STATE_MACHINE_ARN`**: Step Function ARN (auto-set by SAM).

To change the `SES_EMAIL`, modify the `template.yaml` file before deployment. Ensure the email is verified in SES.

## Monitoring and Debugging

- **Logs**: View Lambda function logs in [Amazon CloudWatch](https://aws.amazon.com/cloudwatch/).
- **Workflow Tracking**: Monitor Step Function executions in the [AWS Step Functions console](https://aws.amazon.com/step-functions/).
- Ensure your AWS IAM role has permissions to access these services.

## License

This project is licensed under the MIT License.
