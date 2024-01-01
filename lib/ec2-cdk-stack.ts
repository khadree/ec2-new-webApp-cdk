import { readFileSync } from 'fs';
import {Vpc, Subnet, Peer, Port, AmazonLinuxGeneration,
AmazonLinuxCpuType, Instance, SecurityGroup, AmazonLinuxImage, InstanceClass,
InstanceSize, InstanceType, SubnetType
} from 'aws-cdk-lib/aws-ec2';
import * as cdk from 'aws-cdk-lib'
import { Role, ServicePrincipal, ManagedPolicy } from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { Pipeline, Artifact } from 'aws-cdk-lib/aws-codepipeline';
import { GitHubSourceAction, CodeBuildAction, CodeDeployServerDeployAction } from 'aws-cdk-lib/aws-codepipeline-actions';
import { PipelineProject, LinuxBuildImage } from 'aws-cdk-lib/aws-codebuild';
import { ServerDeploymentGroup, ServerApplication, InstanceTagSet } from 'aws-cdk-lib/aws-codedeploy';
// import * as sqs from 'aws-cdk-lib/aws-sqs';

export class Ec2CdkStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const webServerRole = new Role(this, "ec2Role", {
      assumedBy: new ServicePrincipal("ec2.amazonaws.com")
    });

    //IAM policy attachment to allow access to
    webServerRole.addManagedPolicy(ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore"));

    webServerRole.addManagedPolicy(
      ManagedPolicy.fromAwsManagedPolicyName("service-role/AmazonEC2RoleforAWSCodeDeploy"));

    //This create a VPC with 3 public subnets 
    const vpc = new Vpc(this, 'MyDemo_NewVPC',{
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'pub01',
          subnetType: SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: 'pub02',
          subnetType: SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: 'pub03',
          subnetType: SubnetType.PUBLIC,
        }
      ]
    });

    //Security group
    // This SG will only allow HTTP trafic to the Web Server
    const webSg = new SecurityGroup(this, 'web_Sg', {
      vpc,
      description: "Allows Inbound HTTP traffic to the web server",
      allowAllOutbound: true,
    });

    webSg.addIngressRule(
      Peer.anyIpv4(),
      Port.tcp(80)
    );

    // the AMI to be used for the EC2 Instance
    const ami = new AmazonLinuxImage({
      generation: AmazonLinuxGeneration.AMAZON_LINUX_2,
      cpuType: AmazonLinuxCpuType.X86_64
    });

    // The actual Web EC2 Instance for the web server
    const webServer = new Instance(this, 'web_server', {
      vpc,
      instanceType: InstanceType.of(
        InstanceClass.T2,
        InstanceSize.MICRO,
      ),
      machineImage: ami,
      securityGroup: webSg,
      role: webServerRole,
    });

    // User data - used for bootstrapping

    const webSGUserData = readFileSync('./assets/configure_amz_linux_sample_app.sh', 'utf-8');
    webServer.addUserData(webSGUserData);
    // Tag the instance
    cdk.Tags.of(webServer).add('application-name', 'python-web')
    cdk.Tags.of(webServer).add('stage', 'prod')

    // Output the public IP address of the EC2 instance
    new cdk.CfnOutput(this, 'IP Address', {
      value: webServer.instancePublicIp,
    });

    // CodePipeline
    const pipeline = new Pipeline(this, 'python_web_pipeline', {
      pipelineName: 'python-webApp',
      crossAccountKeys: false, // solves the encrypted bucket issues
    });

    // Stages
    // Source stage
    const sourceStage = pipeline.addStage({
      stageName: 'Source',
    });

     // Build stage
     const buildStage = pipeline.addStage({
      stageName: 'Build',
    });

     // Deploy stage
     const deployStage = pipeline.addStage({
      stageName: 'Deploy',
    });

    // Source Action
    const sourceOutput = new Artifact();
    const githubSourceAction = new GitHubSourceAction({
      actionName: 'GithubSource',
      oauthToken: cdk.SecretValue.secretsManager('github-oauth-token'),
      owner: 'khadree',
      repo: 'sample-python-web-app',
      branch: 'main',
      output: sourceOutput
    });

    sourceStage.addAction(githubSourceAction);

    // Build Action
    const pythonTestProject = new PipelineProject(this, 'pythonTestProject', {
      environment: {
        buildImage: LinuxBuildImage.AMAZON_LINUX_2_3
      }
    });

    const pythonTestOutput = new Artifact();
    const pythonTestAction = new CodeBuildAction({
      actionName: 'TestPython',
      project: pythonTestProject,
      input: sourceOutput,
      outputs: [pythonTestOutput]
    });

    buildStage.addAction(pythonTestAction);

    // Deploy Actions
    const pythonDeployApplication = new ServerApplication(this, "python_deploy_application", {
      applicationName: 'python-webapp'
    });

    //Deployment group
    const pythonServerDeploymentGroup = new ServerDeploymentGroup(this, 'pythonAppDeployGroup',{
      application: pythonDeployApplication,
      deploymentGroupName: 'PythonAppDeploymentGroup',
      installAgent: true,
      ec2InstanceTags: new InstanceTagSet({
        'application-name': ['python-web'],
        'stage': ['prod', 'stage']
      })
    });

    //Deployment action
    const pythonDeployAction = new CodeDeployServerDeployAction({
      actionName: 'PythonAppDeployment',
      input: sourceOutput,
      deploymentGroup: pythonServerDeploymentGroup,
    });
    deployStage.addAction(pythonDeployAction);

     // Output the public IP address of the EC2 instance
    // new cdk.CfnOutput(this, "IP Address", {
    //   value: webServer.instancePublicIp,
    // });


  } 
}
