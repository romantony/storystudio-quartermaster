import { Stack, StackProps, CfnOutput, Duration, RemovalPolicy, Size } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3assets from 'aws-cdk-lib/aws-s3-assets';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as path from 'path';
import { buildOrchestratorTailDefinition } from './orchestrator-tail';

/**
 * QMOrchestratorTailStack — the VPS orchestrator's assembly tail, in its OWN
 * stack (2026-10-02, operator's call).
 *
 * Why not QMPipelineStack: that stack carries the AWS live path, and deploying
 * it would also ship every live-path change committed since its last deploy
 * (8 commits on 2026-10-02: provisioner pod pools, the M0.5 lease, the ModelsLab
 * decommission, queue-index readers). This stack only ADDS resources and
 * IMPORTS a few existing ones by name, so deploying it cannot change anything
 * the live path runs:
 *
 *   imported (read-only use)  cluster `qm-concat-and-trim`, ECR repo
 *                             `qm-concat-and-trim`, bucket
 *                             `qm-remove-silence-output`, the account's shared
 *                             `ecsTaskExecutionRole`, the RunPod key secret
 *   new                       task definition `qm-orchestrator-tail` on the
 *                             image tag `orchestrator-tail` (never `:latest`,
 *                             which the live path's task definition pins), its
 *                             task role, log group, security group, CodeBuild
 *                             project, the QM-orchestrator-runpod Lambda, the
 *                             state machine + its role, and the VPS policy.
 *
 * Plan and reasoning: docs/qm-sfn-ecs-tail-implementation-2026-10-02.md.
 */
export interface OrchestratorTailStackProps extends StackProps {
  runpodKeySecretArn: string;
}

/** Names of the live path's resources this stack reuses. Physical names, read
 * from QMPipelineStack on 2026-10-02 — that stack exports nothing, and adding
 * exports would mean deploying it. */
const CLUSTER_NAME = 'qm-concat-and-trim';
const REPOSITORY_NAME = 'qm-concat-and-trim';
const OUTPUT_BUCKET_NAME = 'qm-remove-silence-output';
const EXECUTION_ROLE_NAME = 'ecsTaskExecutionRole';

export const STATE_MACHINE_NAME = 'E2E-VideoGenerationPipeline-Orchestrator';
export const IMAGE_TAG = 'orchestrator-tail';
const CONTAINER_NAME = 'orchestrator-tail';

/** BGM-S2T: serves both `transcribe` (word-level captions) and `bgm`. */
const AUDIO_ENDPOINT_ID = '6apg6j7suzuezw';

export class OrchestratorTailStack extends Stack {
  constructor(scope: Construct, id: string, props: OrchestratorTailStackProps) {
    super(scope, id, props);

    const vpc = ec2.Vpc.fromLookup(this, 'DefaultVpc', { isDefault: true });
    const repo = ecr.Repository.fromRepositoryName(this, 'Repo', REPOSITORY_NAME);
    const bucket = s3.Bucket.fromBucketName(this, 'OutputBucket', OUTPUT_BUCKET_NAME);
    const executionRole = iam.Role.fromRoleName(this, 'ExecutionRole', EXECUTION_ROLE_NAME, { mutable: false });

    // ── image build ──────────────────────────────────────────────────────────
    // Same Docker context as the live path's image (it carries both
    // entrypoints), its own buildspec that pushes ONLY :orchestrator-tail.
    // CodeBuild does not run on deploy: `aws codebuild start-build
    // --project-name qm-orchestrator-tail-build` publishes the image.
    const buildContext = new s3assets.Asset(this, 'BuildContext', {
      path: path.join(__dirname, '../docker/concat-and-trim'),
      exclude: ['node_modules', 'dist', '__tests__'],
    });
    const buildProject = new codebuild.Project(this, 'BuildProject', {
      projectName: 'qm-orchestrator-tail-build',
      source: codebuild.Source.s3({ bucket: buildContext.bucket, path: buildContext.s3ObjectKey }),
      environment: { buildImage: codebuild.LinuxBuildImage.STANDARD_7_0, privileged: true },
      environmentVariables: {
        REPOSITORY_URI: { value: repo.repositoryUri },
        IMAGE_TAG: { value: IMAGE_TAG },
        AWS_ACCOUNT_ID: { value: this.account },
        AWS_DEFAULT_REGION: { value: this.region },
      },
      buildSpec: codebuild.BuildSpec.fromSourceFilename('buildspec-tail.yml'),
    });
    repo.grantPullPush(buildProject);

    // ── task definition ──────────────────────────────────────────────────────
    const taskRole = new iam.Role(this, 'TaskRole', {
      roleName: 'qm-orchestrator-tail-task-role',
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    // Writes clips/video/audio/meta/final/result, all under projects/*/tail/.
    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:PutObject'],
      resources: [bucket.arnForObjects('projects/*')],
    }));

    const logGroup = new logs.LogGroup(this, 'LogGroup', {
      logGroupName: '/qm/orchestrator-tail',
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // Same sizing as the live path's concat-and-trim (8 vCPU / 32GB / 50GB):
    // the same libx264-bound work, plus the finalize 1080p encode.
    const taskDef = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      family: 'qm-orchestrator-tail',
      cpu: 8192,
      memoryLimitMiB: 32768,
      ephemeralStorageGiB: 50,
      taskRole,
      executionRole,
    });
    taskDef.addContainer('Tail', {
      containerName: CONTAINER_NAME,
      image: ecs.ContainerImage.fromEcrRepository(repo, IMAGE_TAG),
      command: ['node', 'tail.js'],
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'orchestrator-tail', logGroup }),
      environment: { OUTPUT_BUCKET: OUTPUT_BUCKET_NAME, FONTS_DIR: '/opt/fonts' },
    });

    const sg = new ec2.SecurityGroup(this, 'TaskSg', {
      vpc,
      description: 'QM orchestrator tail Fargate task - outbound only',
      allowAllOutbound: true,
    });

    // ── RunPod Lambda ────────────────────────────────────────────────────────
    // The only place the machine talks to RunPod: key stays in Secrets Manager,
    // and a transcribe result (every word + timestamp, easily >100KB) is trimmed
    // to its SRT url before it can hit Step Functions' 256KB state limit.
    const runpodFn = new nodejs.NodejsFunction(this, 'RunpodFunction', {
      functionName: 'QM-orchestrator-runpod',
      entry: path.join(__dirname, '../../src/handlers/orchestrator-runpod.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: Duration.seconds(60),
      memorySize: 256,
      bundling: { minify: true, sourceMap: false, externalModules: [] },
      environment: { RUNPOD_API_KEY_ARN: props.runpodKeySecretArn },
    });
    runpodFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [props.runpodKeySecretArn],
    }));

    // ── state machine ────────────────────────────────────────────────────────
    // Dedicated role — not the shared E2E-StepFunction-Role (~15 other
    // pipelines depend on it, and its PassRole list is edited by hand).
    const sfnRole = new iam.Role(this, 'SfnRole', {
      roleName: 'qm-orchestrator-tail-sfn-role',
      assumedBy: new iam.ServicePrincipal('states.amazonaws.com'),
    });
    sfnRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ecs:RunTask'],
      resources: [`arn:aws:ecs:${this.region}:${this.account}:task-definition/qm-orchestrator-tail:*`],
    }));
    sfnRole.addToPolicy(new iam.PolicyStatement({ actions: ['ecs:StopTask', 'ecs:DescribeTasks'], resources: ['*'] }));
    sfnRole.addToPolicy(new iam.PolicyStatement({
      actions: ['iam:PassRole'],
      resources: [taskRole.roleArn, executionRole.roleArn],
      conditions: { StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' } },
    }));
    // ecs:runTask.sync waits on this managed EventBridge rule.
    sfnRole.addToPolicy(new iam.PolicyStatement({
      actions: ['events:PutTargets', 'events:PutRule', 'events:DescribeRule'],
      resources: [`arn:aws:events:${this.region}:${this.account}:rule/StepFunctionsGetEventsForECSTaskRule`],
    }));
    runpodFn.grantInvoke(sfnRole);
    // Reads meta.json / result.json back.
    sfnRole.addToPolicy(new iam.PolicyStatement({ actions: ['s3:GetObject'], resources: [bucket.arnForObjects('projects/*')] }));

    const definition = buildOrchestratorTailDefinition({
      clusterArn: `arn:aws:ecs:${this.region}:${this.account}:cluster/${CLUSTER_NAME}`,
      taskDefinitionArn: taskDef.taskDefinitionArn,
      containerName: CONTAINER_NAME,
      subnetIds: vpc.publicSubnets.map((s) => s.subnetId),
      securityGroupId: sg.securityGroupId,
      bucket: OUTPUT_BUCKET_NAME,
      runpodFunctionArn: runpodFn.functionArn,
      audioEndpointId: AUDIO_ENDPOINT_ID,
    });

    const stateMachine = new sfn.CfnStateMachine(this, 'StateMachine', {
      stateMachineName: STATE_MACHINE_NAME,
      stateMachineType: 'STANDARD',
      roleArn: sfnRole.roleArn,
      // definitionString preserves JSON nulls, as every other machine here does.
      definitionString: JSON.stringify(definition),
      tags: [{ key: 'batchjob', value: 'true' }, { key: 'orchestrator', value: 'true' }],
    });

    // ── QM-animate: per-frame Ken Burns for narration-basic (2026-10-03) ──
    // The orchestrator invokes it once per frame, during generation, so the
    // Remotion overlay has a real clip to draw on and every frame animates in
    // parallel (see infra/docker/animate-lambda/handler.ts). CPU only: ffmpeg
    // zoompan, ~7s per frame at 10 GB. Deploy with
    // BUILDX_NO_DEFAULT_ATTESTATIONS=1 — Lambda rejects images that carry a
    // buildx provenance attestation.
    const animateFn = new lambda.DockerImageFunction(this, 'AnimateFunction', {
      functionName: 'QM-animate',
      description: 'Per-frame Ken Burns clip for the orchestrator (narration-basic motionEngine=animate)',
      code: lambda.DockerImageCode.fromImageAsset(path.join(__dirname, '../docker'), {
        file: 'animate-lambda/Dockerfile',
        platform: Platform.LINUX_AMD64,
        exclude: ['**/node_modules', '**/__tests__', '**/dist'],
      }),
      architecture: lambda.Architecture.X86_64,
      memorySize: 10240,
      timeout: Duration.seconds(300),
      ephemeralStorageSize: Size.gibibytes(2),
      environment: { OUTPUT_BUCKET: OUTPUT_BUCKET_NAME },
      logGroup: new logs.LogGroup(this, 'AnimateLogs', {
        logGroupName: '/aws/lambda/QM-animate',
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
    });
    bucket.grantPut(animateFn, 'projects/*');

    // What the VPS orchestrator's IAM user needs, and nothing else. Attached BY
    // HAND to `qm-orchestrator-remotion-invoke` (not CDK-managed): a deploy
    // should not edit the credential a production box runs on.
    const controlPolicy = new iam.ManagedPolicy(this, 'ControlPolicy', {
      managedPolicyName: 'qm-orchestrator-tail-control',
      description: 'Start, poll and stop the orchestrator assembly-tail executions - nothing else',
      statements: [
        new iam.PolicyStatement({ actions: ['states:StartExecution'], resources: [stateMachine.attrArn] }),
        new iam.PolicyStatement({
          actions: ['states:DescribeExecution', 'states:StopExecution'],
          resources: [`arn:aws:states:${this.region}:${this.account}:execution:${STATE_MACHINE_NAME}:*`],
        }),
        // The `animate` asset agent (2026-10-03).
        new iam.PolicyStatement({ actions: ['lambda:InvokeFunction'], resources: [animateFn.functionArn] }),
      ],
    });

    new CfnOutput(this, 'StateMachineArn', {
      value: stateMachine.attrArn,
      description: 'Set as SFN_TAIL_STATE_MACHINE_ARN in /opt/qm-orchestrator/.env on the VPS.',
    });
    new CfnOutput(this, 'ControlPolicyArn', {
      value: controlPolicy.managedPolicyArn,
      description: 'Attach to the VPS IAM user qm-orchestrator-remotion-invoke.',
    });
    new CfnOutput(this, 'BuildProjectName', { value: buildProject.projectName });
    new CfnOutput(this, 'AnimateFunctionName', { value: animateFn.functionName });
  }
}
