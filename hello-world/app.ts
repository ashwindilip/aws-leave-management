import { DynamoDBClient, PutItemCommand, GetItemCommand } from "@aws-sdk/client-dynamodb";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { SFNClient, SendTaskSuccessCommand } from "@aws-sdk/client-sfn";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { APIGatewayTokenAuthorizerEvent, APIGatewayAuthorizerResult } from 'aws-lambda';
import * as jwt from 'jsonwebtoken';

const dynamo = new DynamoDBClient({});
const ses = new SESClient({});
const sfn = new SFNClient({});
const TABLE_NAME = process.env.TABLE_NAME!;
const SES_EMAIL = process.env.SES_EMAIL!;

export const authorizer = async (event: APIGatewayTokenAuthorizerEvent): Promise<APIGatewayAuthorizerResult> => {
  try {
    const token = event.authorizationToken.replace('Bearer ', '');
    const secret = process.env.JWT_SECRET;

    if (!secret) {
      throw new Error('Missing JWT_SECRET environment variable');
    }

    const decoded = jwt.verify(token, secret) as { email: string };

    const policy: APIGatewayAuthorizerResult = {
      principalId: decoded.email,
      policyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Action: 'execute-api:Invoke',
            Effect: 'Allow',
            Resource: event.methodArn,
          },
        ],
      },
      context: {
        userEmail: decoded.email,
      },
    };

    return policy;
  } catch (error) {
    console.error('Authorization error:', error);
    const denyPolicy: APIGatewayAuthorizerResult = {
      principalId: 'unauthorized',
      policyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Action: 'execute-api:Invoke',
            Effect: 'Deny',
            Resource: event.methodArn,
          },
        ],
      },
    };
    return denyPolicy;
  }
};

export const applyLeave = async (event: any): Promise<any> => {
  try {
    if (!TABLE_NAME || !SES_EMAIL) {
      throw new Error("Missing required environment variables");
    }

    const { requestId, userEmail, approverEmail, leaveDetails } = event;

    if (!userEmail) {
      throw new Error("Unauthorized: Missing userEmail");
    }

    if (!leaveDetails || !leaveDetails.leaveType || !leaveDetails.startDate || !leaveDetails.endDate || !approverEmail) {
      throw new Error("Missing required fields in leaveDetails or approverEmail");
    }

    console.log("Applying leave for:", userEmail, "Request ID:", requestId);

    await dynamo.send(new PutItemCommand({
      TableName: TABLE_NAME,
      Item: {
        requestId: { S: requestId },
        userEmail: { S: userEmail },
        approverEmail: { S: approverEmail },
        leaveType: { S: leaveDetails.leaveType },
        startDate: { S: leaveDetails.startDate },
        endDate: { S: leaveDetails.endDate },
        reason: { S: leaveDetails.reason || "Not provided" },
        status: { S: "PENDING" }
      }
    }));

   
    return {
      requestId,
      userEmail,
      approverEmail,
      leaveDetails
    };
  } catch (error) {
    console.error("Error in applyLeave:", error);
    throw error; 
  }
};

// Remaining functions (sendApprovalEmail, processApproval, notifyUser) remain unchanged
export const sendApprovalEmail = async (event: any): Promise<void> => {
    try {
      const { requestId, userEmail, approverEmail, leaveDetails, taskToken, apiBaseUrl } = event;
  
      const approveUrl = `${apiBaseUrl}/process-approval?requestId=${requestId}&action=approve&taskToken=${encodeURIComponent(taskToken)}`;
      const rejectUrl = `${apiBaseUrl}/process-approval?requestId=${requestId}&action=reject&taskToken=${encodeURIComponent(taskToken)}`;
  
      const emailParams = {
        Destination: { ToAddresses: [approverEmail] },
        Message: {
          Body: {
            Html: {
              Data: `
                <!DOCTYPE html>
                <html lang="en">
                <head>
                  <meta charset="UTF-8">
                  <style>
                    body { font-family: 'Helvetica', 'Arial', sans-serif; color: #4a4a4a; margin: 0; padding: 0; }
                    .container { max-width: 500px; margin: 20px auto; }
                    .header { border-bottom: 1px solid #e0e0e0; padding-bottom: 10px; margin-bottom: 20px; }
                    h2 { font-size: 20px; color: #5a8296; margin: 0; }
                    p { font-size: 14px; margin: 10px 0; }
                    .details-table { width: 100%; font-size: 14px; margin: 15px 0; }
                    .details-table td { padding: 5px 0; }
                    .buttons { margin: 20px 0; }
                    .button { display: inline-block; padding: 8px 16px; text-decoration: none; color: white; font-size: 14px; border-radius: 4px; margin-right: 10px; }
                    .approve { background-color: #6b8290; }
                    .reject { background-color: #a68e8e; }
                    .footer { font-size: 12px; color: #7a7a7a; margin-top: 20px; }
                  </style>
                </head>
                <body>
                  <div class="container">
                    <div class="header">
                      <h2>Leave Approval Request</h2>
                    </div>
                    <p>Dear Approver,</p>
                    <p>A leave request (${requestId}) from ${userEmail} requires your approval:</p>
                    <table class="details-table">
                      <tr><td>Leave Type:</td><td>${leaveDetails.leaveType}</td></tr>
                      <tr><td>Start Date:</td><td>${leaveDetails.startDate}</td></tr>
                      <tr><td>End Date:</td><td>${leaveDetails.endDate}</td></tr>
                      <tr><td>Reason:</td><td>${leaveDetails.reason}</td></tr>
                    </table>
                    <div class="buttons">
                      <a href="${approveUrl}" class="button approve">Approve</a>
                      <a href="${rejectUrl}" class="button reject">Reject</a>
                    </div>
                    <div class="footer">
                      <p>Leave Management Team</p>
                    </div>
                  </div>
                </body>
                </html>
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
      throw error;
    }
};

export const processApproval = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const queryParams = event.queryStringParameters || {};
    const { requestId, action, taskToken } = queryParams;

    if (!requestId || !action || !taskToken) {
      return { 
        statusCode: 400, 
        headers: { "Content-Type": "text/html" },
        body: `
          <!DOCTYPE html>
          <html lang="en">
          <head>
            <meta charset="UTF-8">
            <title>Error</title>
            <style>
              body { font-family: 'Helvetica', 'Arial', sans-serif; margin: 0; padding: 0; color: #333; }
              .container { max-width: 600px; margin: 50px auto; padding: 20px; }
              h1 { color: #a68e8e; }
            </style>
          </head>
          <body>
            <div class="container">
              <h1>Error</h1>
              <p>Missing required parameters. Please contact support.</p>
            </div>
          </body>
          </html>
        `
      };
    }

    const approvalStatus = action === "approve" ? "APPROVED" : "REJECTED";
    console.log(`Processing ${approvalStatus} for request: ${requestId}`);

    await sfn.send(new SendTaskSuccessCommand({
      taskToken,
      output: JSON.stringify({ approvalStatus })
    }));

    const statusMessage = approvalStatus === "APPROVED" ? "approved" : "rejected";
    const statusColor = approvalStatus === "APPROVED" ? "#6b8290" : "#a68e8e";

    return {
      statusCode: 200,
      headers: { "Content-Type": "text/html" },
      body: `
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="UTF-8">
          <title>Leave Request Status</title>
          <style>
            body { font-family: 'Helvetica', 'Arial', sans-serif; margin: 0; padding: 0; color: #333; }
            .container { max-width: 600px; margin: 50px auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 5px; box-shadow: 0 2px 5px rgba(0,0,0,0.1); }
            .header { border-bottom: 1px solid #e0e0e0; padding-bottom: 15px; margin-bottom: 20px; }
            h1 { color: #5a8296; margin: 0; font-size: 24px; }
            .status { color: ${statusColor}; font-weight: bold; }
            p { font-size: 16px; line-height: 1.5; margin: 10px 0; }
            .footer { margin-top: 20px; font-size: 12px; color: #777; text-align: center; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>Leave Request Status</h1>
            </div>
            <p>Your leave request (<strong>${requestId}</strong>) has been <span class="status">${statusMessage}</span> successfully.</p>
            <p>Please contact your HR department if you have any questions regarding this request.</p>
            <div class="footer">
              <p>Leave Management System | © ${new Date().getFullYear()} All Rights Reserved</p>
            </div>
          </div>
        </body>
        </html>
      `
    };
  } catch (error) {
    console.error("Error in processApproval:", error);
    return { 
      statusCode: 500,
      headers: { "Content-Type": "text/html" },
      body: `
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="UTF-8">
          <title>Error</title>
          <style>
            body { font-family: 'Helvetica', 'Arial', sans-serif; margin: 0; padding: 0; color: #333; }
            .container { max-width: 600px; margin: 50px auto; padding: 20px; }
            h1 { color: #a68e8e; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>Internal Server Error</h1>
            <p>Something went wrong while processing your request. Please try again later or contact support.</p>
          </div>
        </body>
        </html>
      `
    };
  }
};

export const notifyUser = async (event: any): Promise<void> => {
  try {
    const { requestId, userEmail, approvalStatus, leaveDetails } = event;

    const statusText = approvalStatus === "APPROVED" ? "Approved" : "Rejected";
    const emailParams = {
      Destination: { ToAddresses: [userEmail] },
      Message: {
        Body: {
          Html: {
            Data: `
              <!DOCTYPE html>
              <html lang="en">
              <head>
                <meta charset="UTF-8">
                <style>
                  body { font-family: 'Helvetica', 'Arial', sans-serif; color: #4a4a4a; margin: 0; padding: 0; }
                  .container { max-width: 500px; margin: 20px auto; }
                  .header { border-bottom: 1px solid #e0e0e0; padding-bottom: 10px; margin-bottom: 20px; }
                  h2 { font-size: 20px; color: #5a8296; margin: 0; }
                  p { font-size: 14px; margin: 10px 0; }
                  .status-approved { color: #6b8290; }
                  .status-rejected { color: #a68e8e; }
                  .details-table { width: 100%; font-size: 14px; margin: 15px 0; }
                  .details-table td { padding: 5px 0; }
                  .footer { font-size: 12px; color: #7a7a7a; margin-top: 20px; }
                </style>
              </head>
              <body>
                <div class="container">
                  <div class="header">
                    <h2>Leave Request Outcome</h2>
                  </div>
                  <p>Dear User,</p>
                  <p>Your leave request (${requestId}) has been <span class="status-${statusText.toLowerCase()}">${statusText}</span>.</p>
                  <table class="details-table">
                    <tr><td>Leave Type:</td><td>${leaveDetails.leaveType}</td></tr>
                    <tr><td>Start Date:</td><td>${leaveDetails.startDate}</td></tr>
                    <tr><td>End Date:</td><td>${leaveDetails.endDate}</td></tr>
                    <tr><td>Reason:</td><td>${leaveDetails.reason}</td></tr>
                  </table>
                  <div class="footer">
                    <p>Leave Management Team</p>
                  </div>
                </div>
              </body>
              </html>
            `
          }
        },
        Subject: { Data: `Leave Request ${requestId}` }
      },
      Source: SES_EMAIL
    };

    console.log("Notifying user:", userEmail, "Status:", statusText);
    await ses.send(new SendEmailCommand(emailParams));
  } catch (error) {
    console.error("Error in notifyUser:", error);
    throw error;
  }
};