import { DynamoDBClient, PutItemCommand, GetItemCommand } from "@aws-sdk/client-dynamodb";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { SFNClient, StartExecutionCommand, SendTaskSuccessCommand } from "@aws-sdk/client-sfn"; // New import for Step Functions
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";

const dynamo = new DynamoDBClient({});
const ses = new SESClient({});
const sfn = new SFNClient({}); // Step Functions client
const TABLE_NAME = process.env.TABLE_NAME!;
const SES_EMAIL = process.env.SES_EMAIL!;
const STATE_MACHINE_ARN = process.env.STATE_MACHINE_ARN!; // Add this to your env vars

// Apply for Leave - Triggers Step Functions
export const applyLeave = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    try {
      if (!TABLE_NAME || !SES_EMAIL || !STATE_MACHINE_ARN) {
        throw new Error("Missing required environment variables");
      }
  
      const body = JSON.parse(event.body || "{}");
      if (!body.userEmail || !body.leaveType || !body.startDate || !body.endDate || !body.approverEmail) {
        return { statusCode: 400, body: JSON.stringify({ message: "Missing required fields" }) };
      }
  
      const requestId = `LEAVE-${Date.now()}`;
      console.log("Applying leave for:", body.userEmail, "Request ID:", requestId);
  
      // Store initial request in DynamoDB
      await dynamo.send(new PutItemCommand({
        TableName: TABLE_NAME,
        Item: {
          requestId: { S: requestId },
          userEmail: { S: body.userEmail },
          approverEmail: { S: body.approverEmail },
          leaveType: { S: body.leaveType },
          startDate: { S: body.startDate },
          endDate: { S: body.endDate },
          reason: { S: body.reason || "Not provided" },
          status: { S: "PENDING" }
        }
      }));
  
      // Extract API URL from event
      const apiBaseUrl = `https://${event.requestContext.domainName}/${event.requestContext.stage}`;
  
      // Start Step Functions execution with apiBaseUrl
      const input = {
        requestId,
        userEmail: body.userEmail,
        approverEmail: body.approverEmail,
        leaveDetails: {
          leaveType: body.leaveType,
          startDate: body.startDate,
          endDate: body.endDate,
          reason: body.reason || "Not provided"
        },
        apiBaseUrl
      };
  
      await sfn.send(new StartExecutionCommand({
        stateMachineArn: STATE_MACHINE_ARN,
        input: JSON.stringify(input)
      }));
  
      return {
        statusCode: 200,
        body: JSON.stringify({ message: "Leave applied", requestId })
      };
    } catch (error) {
      console.error("Error in applyLeave:", error);
      return { statusCode: 500, body: JSON.stringify({ message: "Internal server error" }) };
    }
  };
// Send Approval Email - Sends email with buttons and task token
export const sendApprovalEmail = async (event: any): Promise<void> => {
    try {
      const { requestId, userEmail, approverEmail, leaveDetails, taskToken, apiBaseUrl } = event;
  
      // Generate approval/rejection URLs with task token
      const approveUrl = `${apiBaseUrl}/process-approval?requestId=${requestId}&action=approve&taskToken=${encodeURIComponent(taskToken)}`;
      const rejectUrl = `${apiBaseUrl}/process-approval?requestId=${requestId}&action=reject&taskToken=${encodeURIComponent(taskToken)}`;
  
      const emailParams = {
        Destination: { ToAddresses: [approverEmail] },
        Message: {
          Body: {
            Html: {
              Data: `
                <p>A leave request (${requestId}) from ${userEmail} needs your approval:</p>
                <p>Details: ${JSON.stringify(leaveDetails)}</p>
                <p><a href="${approveUrl}"><button>Approve</button></a> <a href="${rejectUrl}"><button>Reject</button></a></p>
              `
            }
          },
          Subject: { Data: "Leave Approval Request" }
        },
        Source: SES_EMAIL
      };
  
      console.log("Sending approval email for request:", requestId);
      await ses.send(new SendEmailCommand(emailParams));
    } catch (error) {
      console.error("Error in sendApprovalEmail:", error);
      throw error; // Let Step Functions handle the retry/failure
    }
  };
// Process Approval - Handles button clicks and resumes Step Functions
export const processApproval = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const queryParams = event.queryStringParameters || {};
    const { requestId, action, taskToken } = queryParams;

    if (!requestId || !action || !taskToken) {
      return { statusCode: 400, body: JSON.stringify({ message: "Missing required query parameters" }) };
    }

    const approvalStatus = action === "approve" ? "APPROVED" : "REJECTED";
    console.log(`Processing ${approvalStatus} for request: ${requestId}`);

    // Resume Step Functions with the approval status
    await sfn.send(new SendTaskSuccessCommand({
      taskToken,
      output: JSON.stringify({ approvalStatus })
    }));

    return {
      statusCode: 200,
      body: JSON.stringify({ message: `Leave request ${requestId} ${approvalStatus.toLowerCase()}` })
    };
  } catch (error) {
    console.error("Error in processApproval:", error);
    return { statusCode: 500, body: JSON.stringify({ message: "Internal server error" }) };
  }
};

// Notify User - Sends final notification
export const notifyUser = async (event: any): Promise<void> => {
  try {
    const { requestId, userEmail, approvalStatus, leaveDetails } = event;

    const statusText = approvalStatus === "APPROVED" ? "APPROVED" : "REJECTED";
    const emailParams = {
      Destination: { ToAddresses: [userEmail] },
      Message: {
        Body: {
          Html: {
            Data: `
              <p>Your leave request (${requestId}) has been ${statusText}.</p>
              <p>Details: ${JSON.stringify(leaveDetails)}</p>
            `
          }
        },
        Subject: { Data: "Leave Request Outcome" }
      },
      Source: SES_EMAIL
    };

    console.log("Notifying user:", userEmail, "Status:", statusText);
    await ses.send(new SendEmailCommand(emailParams));
  } catch (error) {
    console.error("Error in notifyUser:", error);
    throw error; // Let Step Functions handle the retry/failure
  }
};