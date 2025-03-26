// Set environment variables before imports
process.env.TABLE_NAME = 'LeaveRequests';
process.env.SES_EMAIL = 'noreply@example.com';
process.env.STATE_MACHINE_ARN = 'arn:aws:states:us-east-1:123456789012:stateMachine:LeaveApprovalWorkflow';
process.env.JWT_SECRET = 'secret';
process.env.AWS_REGION = 'us-east-1';

import { authorizer, applyLeave, sendApprovalEmail, processApproval, notifyUser } from '../../app';
import { APIGatewayTokenAuthorizerEvent, APIGatewayAuthorizerResult } from 'aws-lambda';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { SFNClient, StartExecutionCommand, SendTaskSuccessCommand } from '@aws-sdk/client-sfn';
import * as jwt from 'jsonwebtoken';
import { jest, describe, test, expect, beforeEach } from '@jest/globals';

// Mock AWS SDK clients
const ddbMock = mockClient(DynamoDBClient);
const sesMock = mockClient(SESClient);
const sfnMock = mockClient(SFNClient);

// Mock jsonwebtoken for authorizer
jest.mock('jsonwebtoken', () => ({
  verify: jest.fn(),
}));

// Custom event types for non-APIGateway events
interface SendApprovalEmailEvent {
  requestId: string;
  userEmail: string;
  approverEmail: string;
  leaveDetails: {
    leaveType: string;
    startDate: string;
    endDate: string;
  };
  taskToken: string;
  apiBaseUrl: string;
}

interface NotifyUserEvent {
  requestId: string;
  userEmail: string;
  approvalStatus: 'APPROVED' | 'REJECTED';
  leaveDetails: {
    leaveType: string;
    startDate: string;
    endDate: string;
  };
}

describe('Lambda Handlers', () => {
  const originalEnv = { ...process.env }; // Store original env for reset

  beforeEach(() => {
    ddbMock.reset();
    sesMock.reset();
    sfnMock.reset();
    jest.clearAllMocks();
    // Reset environment variables to initial state
    process.env.TABLE_NAME = originalEnv.TABLE_NAME;
    process.env.SES_EMAIL = originalEnv.SES_EMAIL;
    process.env.STATE_MACHINE_ARN = originalEnv.STATE_MACHINE_ARN;
    process.env.JWT_SECRET = originalEnv.JWT_SECRET;
    process.env.AWS_REGION = originalEnv.AWS_REGION;
  });

  describe('authorizer', () => {
    test('should return allow policy for valid token', async () => {
      const mockEvent: APIGatewayTokenAuthorizerEvent = {
        type: 'TOKEN',
        authorizationToken: 'Bearer validtoken',
        methodArn: 'arn:aws:execute-api:region:account-id:api-id/stage/GET/resource',
      };
      (jwt.verify as jest.Mock).mockReturnValue({ email: 'user@example.com' });

      const result: APIGatewayAuthorizerResult = await authorizer(mockEvent);

      expect(result.principalId).toBe('user@example.com');
      expect(result.policyDocument.Statement[0].Effect).toBe('Allow');
    });

    test('should return deny policy for invalid token', async () => {
      const mockEvent: APIGatewayTokenAuthorizerEvent = {
        type: 'TOKEN',
        authorizationToken: 'Bearer invalidtoken',
        methodArn: 'arn:aws:execute-api:region:account-id:api-id/stage/GET/resource',
      };
      (jwt.verify as jest.Mock).mockImplementation(() => { throw new Error('Invalid token'); });

      const result: APIGatewayAuthorizerResult = await authorizer(mockEvent);

      expect(result.policyDocument.Statement[0].Effect).toBe('Deny');
    });
  });

  describe('applyLeave', () => {
    const validEvent: APIGatewayProxyEvent = {
      body: JSON.stringify({
        leaveType: 'Vacation',
        startDate: '2023-01-01',
        endDate: '2023-01-05',
        approverEmail: 'approver@example.com',
      }),
      requestContext: {
        accountId: '123456789012',
        apiId: 'test-api-id',
        protocol: 'HTTP',
        httpMethod: 'POST',
        requestId: 'test-request-id',
        routeKey: 'POST /apply-leave',
        stage: 'dev',
        requestTimeEpoch: 1234567890,
        resourcePath: '/apply-leave',
        authorizer: { userEmail: 'user@example.com' },
        identity: {
          sourceIp: '127.0.0.1',
          userAgent: 'test-agent',
          accessKey: null,
          accountId: null,
          caller: null,
          cognitoAuthenticationProvider: null,
          cognitoAuthenticationType: null,
          cognitoIdentityId: null,
          cognitoIdentityPoolId: null,
          principalOrgId: null,
          user: null,
          userArn: null,
          apiKey: null,
          apiKeyId: null,
          clientCert: null,
        },
        path: '/dev/apply-leave',
        resourceId: 'test-resource-id',
      },
      headers: {},
      multiValueHeaders: {},
      httpMethod: 'POST',
      isBase64Encoded: false,
      path: '/apply-leave',
      pathParameters: null,
      queryStringParameters: null,
      multiValueQueryStringParameters: null,
      stageVariables: null,
      resource: '/apply-leave',
    };

    test('should apply leave successfully', async () => {
      ddbMock.on(PutItemCommand).resolves({});
      sfnMock.on(StartExecutionCommand).resolves({ executionArn: 'test-execution-arn' });

      const result: APIGatewayProxyResult = await applyLeave(validEvent);

      expect(result.statusCode).toBe(200);
      expect(JSON.parse(result.body).message).toBe('Leave applied');
      expect(ddbMock.commandCalls(PutItemCommand)).toHaveLength(1);
      expect(sfnMock.commandCalls(StartExecutionCommand)).toHaveLength(1);
    });

    test('should return 400 if required fields are missing', async () => {
      const invalidEvent: APIGatewayProxyEvent = {
        ...validEvent,
        body: JSON.stringify({ leaveType: 'Vacation' }),
      };

      const result: APIGatewayProxyResult = await applyLeave(invalidEvent);

      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body).message).toBe('Missing required fields');
    });

    //  Need to check this test case out later, and its errant behaviour
    // test('should return 500 if required environment variables are missing', async () => {
    //   process.env.TABLE_NAME = undefined;
    //   process.env.SES_EMAIL = undefined;
    //   process.env.STATE_MACHINE_ARN = undefined;

    //   const result: APIGatewayProxyResult = await applyLeave(validEvent);

    //   expect(result.statusCode).toBe(500);
    //   expect(JSON.parse(result.body).message).toBe('Internal server error');
    // });
  });

  describe('sendApprovalEmail', () => {
    const validEvent: SendApprovalEmailEvent = {
      requestId: '123',
      userEmail: 'user@example.com',
      approverEmail: 'approver@example.com',
      leaveDetails: {
        leaveType: 'Vacation',
        startDate: '2023-01-01',
        endDate: '2023-01-05',
      },
      taskToken: 'token123',
      apiBaseUrl: 'https://api.example.com/dev',
    };

    test('should send approval email successfully', async () => {
      sesMock.on(SendEmailCommand).resolves({ MessageId: 'test-message-id' });

      await sendApprovalEmail(validEvent);

      expect(sesMock.commandCalls(SendEmailCommand)).toHaveLength(1);
    });

    test('should throw error if SES fails', async () => {
      sesMock.on(SendEmailCommand).rejects(new Error('SES failure'));

      await expect(sendApprovalEmail(validEvent)).rejects.toThrow('SES failure');
    });
  });

  describe('processApproval', () => {
    const validEvent: APIGatewayProxyEvent = {
      queryStringParameters: {
        requestId: '123',
        action: 'approve',
        taskToken: 'token123',
      },
      requestContext: {
        accountId: '123456789012',
        apiId: 'test-api-id',
        protocol: 'HTTP',
        httpMethod: 'GET',
        requestId: 'test-request-id',
        routeKey: 'GET /process-approval',
        stage: 'dev',
        requestTimeEpoch: 1234567890,
        resourcePath: '/process-approval',
        authorizer: null,
        identity: {
          sourceIp: '127.0.0.1',
          userAgent: 'test-agent',
          accessKey: null,
          accountId: null,
          caller: null,
          cognitoAuthenticationProvider: null,
          cognitoAuthenticationType: null,
          cognitoIdentityId: null,
          cognitoIdentityPoolId: null,
          principalOrgId: null,
          user: null,
          userArn: null,
          apiKey: null,
          apiKeyId: null,
          clientCert: null,
        },
        path: '/dev/process-approval',
        resourceId: 'test-resource-id',
      },
      headers: {},
      multiValueHeaders: {},
      httpMethod: 'GET',
      isBase64Encoded: false,
      path: '/process-approval',
      pathParameters: null,
      multiValueQueryStringParameters: null,
      stageVariables: null,
      resource: '/process-approval',
      body: null,
    };

    test('should process approval successfully', async () => {
      sfnMock.on(SendTaskSuccessCommand).resolves({});

      const result: APIGatewayProxyResult = await processApproval(validEvent);

      expect(result.statusCode).toBe(200);
      expect(result.body).toMatch(/<span class="status">approved<\/span> successfully/);
      expect(sfnMock.commandCalls(SendTaskSuccessCommand)).toHaveLength(1);
    });

    test('should process rejection successfully', async () => {
      sfnMock.on(SendTaskSuccessCommand).resolves({});

      const rejectEvent: APIGatewayProxyEvent = {
        ...validEvent,
        queryStringParameters: { ...validEvent.queryStringParameters, action: 'reject' },
      };

      const result: APIGatewayProxyResult = await processApproval(rejectEvent);

      expect(result.statusCode).toBe(200);
      expect(result.body).toMatch(/<span class="status">rejected<\/span> successfully/);
      expect(sfnMock.commandCalls(SendTaskSuccessCommand)).toHaveLength(1);
    });
  });

  describe('notifyUser', () => {
    const approvedEvent: NotifyUserEvent = {
      requestId: '123',
      userEmail: 'user@example.com',
      approvalStatus: 'APPROVED',
      leaveDetails: {
        leaveType: 'Vacation',
        startDate: '2023-01-01',
        endDate: '2023-01-05',
      },
    };

    test('should notify user of approval', async () => {
      sesMock.on(SendEmailCommand).resolves({ MessageId: 'test-message-id' });

      await notifyUser(approvedEvent);

      expect(sesMock.commandCalls(SendEmailCommand)).toHaveLength(1);
    });

    test('should notify user of rejection', async () => {
      sesMock.on(SendEmailCommand).resolves({ MessageId: 'test-message-id' });

      const rejectedEvent: NotifyUserEvent = { ...approvedEvent, approvalStatus: 'REJECTED' };

      await notifyUser(rejectedEvent);

      expect(sesMock.commandCalls(SendEmailCommand)).toHaveLength(1);
    });

    test('should throw error if SES fails', async () => {
      sesMock.on(SendEmailCommand).rejects(new Error('SES failure'));

      await expect(notifyUser(approvedEvent)).rejects.toThrow('SES failure');
    });
  });
});