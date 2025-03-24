// app.test.ts
import { authorizer, applyLeave, sendApprovalEmail, processApproval, notifyUser } from '../../app';
import * as jwt from 'jsonwebtoken';
import {jest, describe, beforeEach, it, expect } from '@jest/globals';

// Mock AWS SDK clients
jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: class {
    async send() {}
  },
  PutItemCommand: class {},
  GetItemCommand: class {},
}));

jest.mock('@aws-sdk/client-ses', () => ({
  SESClient: class {
    async send() {}
  },
  SendEmailCommand: class {},
}));

jest.mock('@aws-sdk/client-sfn', () => ({
  SFNClient: class {
    async send() {}
  },
  StartExecutionCommand: class {},
  SendTaskSuccessCommand: class {},
}));

jest.spyOn(console, 'log').mockImplementation(() => {});
jest.spyOn(console, 'error').mockImplementation(() => {});

process.env.TABLE_NAME = 'TestTable';
process.env.SES_EMAIL = 'test@example.com';
process.env.STATE_MACHINE_ARN = 'arn:aws:states:us-east-1:123456789012:stateMachine:TestStateMachine';
process.env.JWT_SECRET = 'test-secret';

describe('Leave Management System Lambda Functions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('authorizer', () => {
    it('allows a valid JWT token', async () => {
      const token = jwt.sign({ email: 'user@example.com' }, process.env.JWT_SECRET!);
      const event: any = {
        authorizationToken: `Bearer ${token}`,
        methodArn: 'arn:aws:execute-api:us-east-1:123456789012:api-id/dev/GET/resource',
      };

      const result = await authorizer(event);

      expect(result.principalId).toBe('user@example.com');
      expect(result.policyDocument.Statement[0].Effect).toBe('Allow');
      expect(result.context?.userEmail).toBe('user@example.com');
    });

    it('denies an invalid JWT token', async () => {
      const event: any = {
        authorizationToken: 'Bearer invalid-token',
        methodArn: 'arn:aws:execute-api:us-east-1:123456789012:api-id/dev/GET/resource',
      };

      const result = await authorizer(event);

      expect(result.principalId).toBe('unauthorized');
      expect(result.policyDocument.Statement[0].Effect).toBe('Deny');
    });
  });

  describe('applyLeave', () => {
    it('applies leave with valid input', async () => {
      const event: any = {
        body: JSON.stringify({
          leaveType: 'Vacation',
          startDate: '2025-04-01',
          endDate: '2025-04-05',
          approverEmail: 'approver@example.com',
        }),
        requestContext: {
          authorizer: { userEmail: 'user@example.com' },
          domainName: 'api.example.com',
          stage: 'dev',
        },
      };

      const result = await applyLeave(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.message).toBe('Leave applied');
      expect(body.requestId).toMatch(/^LEAVE-\d+$/);
    });

    it('rejects missing fields', async () => {
      const event: any = {
        body: JSON.stringify({}),
        requestContext: {
          authorizer: { userEmail: 'user@example.com' },
        },
      };

      const result = await applyLeave(event);

      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body).message).toBe('Missing required fields');
    });

    it('rejects unauthorized request', async () => {
      const event: any = {
        body: JSON.stringify({
          leaveType: 'Vacation',
          startDate: '2025-04-01',
          endDate: '2025-04-05',
          approverEmail: 'approver@example.com',
        }),
        requestContext: {},
      };

      const result = await applyLeave(event);

      expect(result.statusCode).toBe(403);
      expect(JSON.parse(result.body).message).toBe('Unauthorized');
    });
  });

  describe('sendApprovalEmail', () => {
    it('sends approval email with valid input', async () => {
      const event: any = {
        requestId: 'LEAVE-123',
        userEmail: 'user@example.com',
        approverEmail: 'approver@example.com',
        leaveDetails: {
          leaveType: 'Vacation',
          startDate: '2025-04-01',
          endDate: '2025-04-05',
          reason: 'Test',
        },
        taskToken: 'test-token',
        apiBaseUrl: 'https://api.example.com/dev',
      };

      await expect(sendApprovalEmail(event)).resolves.toBeUndefined();
    });
  });

  describe('processApproval', () => {
    it('processes approval successfully', async () => {
      const event: any = {
        queryStringParameters: {
          requestId: 'LEAVE-123',
          action: 'approve',
          taskToken: 'test-token',
        },
      };

      const result = await processApproval(event);

      expect(result.statusCode).toBe(200);
      expect(JSON.parse(result.body).message).toBe('Leave request LEAVE-123 approved');
    });

    it('rejects missing query parameters', async () => {
      const event: any = {
        queryStringParameters: {},
      };

      const result = await processApproval(event);

      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body).message).toBe('Missing required query parameters');
    });
  });

  describe('notifyUser', () => {
    it('notifies user with valid input', async () => {
      const event: any = {
        requestId: 'LEAVE-123',
        userEmail: 'user@example.com',
        approvalStatus: 'APPROVED',
        leaveDetails: {
          leaveType: 'Vacation',
          startDate: '2025-04-01',
          endDate: '2025-04-05',
          reason: 'Test',
        },
      };

      await expect(notifyUser(event)).resolves.toBeUndefined();
    });
  });
});