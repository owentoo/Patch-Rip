# PatchSensei deployment — ECS Fargate

This deploys the Remix app to an ECS Fargate service behind an ALB,
with image builds and rollouts done by GitHub Actions on push to `main`.

## One-time setup

### 1. Apply the CloudFormation stack

```bash
aws cloudformation deploy \
  --stack-name patch-sensei-infra \
  --template-file deploy/cloudformation/infrastructure.yaml \
  --capabilities CAPABILITY_NAMED_IAM \
  --region us-east-1 \
  --parameter-overrides \
    VpcId=vpc-xxxxxxxx \
    PublicSubnetIds=subnet-aaa,subnet-bbb \
    PrivateSubnetIds=subnet-ccc,subnet-ddd \
    CertificateArn=arn:aws:acm:us-east-1:795462798032:certificate/xxxxxxxx
```

This creates:
- ECS cluster `patch-sensei-cluster`
- ALB `patch-sensei-alb` (HTTPS on 443, redirects 80→443)
- Target group + service `patch-sensei-app`
- EFS filesystem for SQLite session storage
- IAM task execution role + task role
- GitHub OIDC provider + deploy role

Outputs include the ALB DNS name and EFS filesystem ID.

### 2. Update task definition with the EFS ID

Take the `EfsFileSystemId` output from the stack and replace
`REPLACE_WITH_EFS_ID` in `deploy/ecs/task-definition.json`. Commit.

### 3. Put secrets in Parameter Store

```bash
aws ssm put-parameter --name /patch-sensei/SHOPIFY_API_KEY     --value "..." --type SecureString
aws ssm put-parameter --name /patch-sensei/SHOPIFY_API_SECRET  --value "..." --type SecureString
aws ssm put-parameter --name /patch-sensei/SHOPIFY_APP_URL     --value "https://patch-sensei.ninjapatches.com" --type String
aws ssm put-parameter --name /patch-sensei/NINJA_RANKER_SECRET --value "..." --type SecureString
```

### 4. Register the first task definition manually

CloudFormation expects a task def named `patch-sensei-app` to exist before
the service can boot. Register a placeholder once:

```bash
aws ecs register-task-definition \
  --cli-input-json file://deploy/ecs/task-definition.json \
  --region us-east-1
```

After this, GitHub Actions handles all updates automatically.

### 5. Point the Shopify Partners app at the ALB

In the Shopify Partner Dashboard create a new app version with:
- App URL: `https://<AlbDnsName>` (or your CNAME pointing at it)
- Allowed redirect URLs: `https://<AlbDnsName>/auth/callback`

## Ongoing

Push to `main` → GitHub Actions builds the image, pushes to ECR, registers a
new task definition, and updates the service. Rolling deploy with
`MinimumHealthyPercent=100` so there's no downtime.

## Rollback

```bash
aws ecs update-service \
  --cluster patch-sensei-cluster \
  --service patch-sensei-app \
  --task-definition patch-sensei-app:<previous-revision> \
  --region us-east-1
```
