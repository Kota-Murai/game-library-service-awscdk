import { Construct } from 'constructs'
import { Stack, StackProps, aws_lambda, aws_apigateway, SecretValue, RemovalPolicy, Duration} from 'aws-cdk-lib'
import { Vpc, CfnVPC, CfnSubnet, VpnConnectionType } from "aws-cdk-lib/aws-ec2";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as rds from 'aws-cdk-lib/aws-rds';
import * as Iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
// import {DatabaseInstance} from 'aws-cdk-lib/aws-rds';


const path = require("path")

export class CdkstackStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props)

    // VPC
    let vpc: ec2.Vpc;
    vpc = new ec2.Vpc(this, "VPC", {
      cidr: "10.0.0.0/16",
      vpcName: `toppovpc`,
      enableDnsHostnames: true,
      enableDnsSupport: true,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: "PublicSubnet",
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: "PrivateSubnetforGameBlog",
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        },
      ],
      maxAzs: 2
    });

    // セキュリティーグループ
    const bastionGroup = new ec2.SecurityGroup(this, 'Bastion to DB', {vpc});
    const lambdaToRDSProxyGroup = new ec2.SecurityGroup(this, "Lambda to RDSProxy", {vpc});
    const dbConnectionGroup = new ec2.SecurityGroup(this, "RDSProxy to DB",{vpc});

    dbConnectionGroup.addIngressRule( // 自分自身からの3306ポートへのアクセスを許可
      ec2.Peer.anyIpv4(),             // 元はdbConnectionGroupだったが変な気がしたのでec2.Peer.anyIpv4()にしておく
      ec2.Port.tcp(3306),
      "allow db connection"
    );

    dbConnectionGroup.addIngressRule( // lambdaToRDSProxyGroupからの3306ポートへのアクセスを許可
      lambdaToRDSProxyGroup,
      ec2.Port.tcp(3306),
      "allow lambda connection"
    );

    dbConnectionGroup.addIngressRule(
      bastionGroup,
      ec2.Port.tcp(3306),
      'allow bastion connection'
    );

    // パブリックサブネットに踏み台サーバを配置する
    const host = new ec2.BastionHostLinux(this, "BastionHost", {
      vpc,
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T2,
        ec2.InstanceSize.MICRO
      ),
      securityGroup: bastionGroup,
      subnetSelection: {
        subnetType: ec2.SubnetType.PUBLIC,
      },
    });
    host.instance.addUserData("yum -y update", "yum install -y mysql jq");

    // RDSの認証情報
    const databaseCredentialsSecret = new secretsmanager.Secret(
      this,
      'DBCredentialsSecret',
      {
        secretName: id + '-rds-credentials',
        generateSecretString: {
          secretStringTemplate: JSON.stringify({
            username: 'MyDBAdmin',
          }),
          excludePunctuation: true,
          includeSpace: false,
          generateStringKey: 'password',
        },
      }
    );

    // Lambda関数からSecret ManagerにアクセスするためのVPCエンドポイント
    new ec2.InterfaceVpcEndpoint(this, "SecretManagerVpcEndpoint", {
      vpc: vpc,
      service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
    });


    
    const rdsInstance = new rds.DatabaseInstance(this, "DBInstance", {
      // データベースエンジンとバージョンの指定
      engine: rds.DatabaseInstanceEngine.mysql({
        version: rds.MysqlEngineVersion.VER_8_0_27,
      }),
      // 認証情報の設定
      // これは非推奨の書き方。シークレットマネージャーを使用して取得するように変更すべき
      // 収益が発生するようになってから変更予定
      credentials: rds.Credentials.fromSecret(databaseCredentialsSecret),
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T2,
        ec2.InstanceSize.MICRO
      ),
      vpc,
      vpcSubnets: {
        // subnetType: ec2.SubnetType.ISOLATED,
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      },
      securityGroups: [dbConnectionGroup],
      removalPolicy: RemovalPolicy.DESTROY,
      deletionProtection: false,
      parameterGroup: new rds.ParameterGroup(this, "ParameterGroup", {
        engine: rds.DatabaseInstanceEngine.mysql({
          version: rds.MysqlEngineVersion.VER_8_0_27,
        }),
        parameters: { // とりあえず全部utf8
          character_set_client:"utf8mb4",
          character_set_connection:"utf8mb4",
          character_set_database:"utf8mb4",
          character_set_results:"utf8mb4",
          character_set_server:"utf8mb4",
        },
      }),
    });

    // RDSプロキシの設定
    const proxy = rdsInstance.addProxy(id + "-proxy", {
      secrets: [databaseCredentialsSecret ],
      debugLogging: true,
      vpc,
      securityGroups: [dbConnectionGroup],
    });

    // Lambdaロール
    const iamRoleForLambda = new Iam.Role(this, "iamRoleForLambda", {
      roleName: `game-blog-lambda-role`,
      assumedBy: new Iam.ServicePrincipal("lambda.amazonaws.com"),
      // VPCに設置するためのポリシー定義
      managedPolicies: [
        Iam.ManagedPolicy.fromAwsManagedPolicyName(
          "service-role/AWSLambdaVPCAccessExecutionRole"
        ),
        Iam.ManagedPolicy.fromAwsManagedPolicyName(
          "SecretsManagerReadWrite"
        )
      ],
    });

    // Lambda関数
    const fn = new aws_lambda.Function(this, 'fn', {
      code: aws_lambda.Code.fromAsset(path.join(__dirname, '../src/')),
      handler: 'index.handler',
      runtime: aws_lambda.Runtime.NODEJS_14_X,
      timeout: Duration.seconds(30),
      role: iamRoleForLambda, // どのIAMロールを使用するか
      vpc:vpc,
      securityGroups: [lambdaToRDSProxyGroup],
      environment: {
        PROXY_ENDPOINT: proxy.endpoint,
        RDS_SECRET_NAME: id + "-rds-credentials",
        // AWS_NODEJS_CONNECTION_REUSE_ENABLED: "1", // keepaliveを有効にする,
        NODE_OPTIONS: '--enable-source-maps'
      },
      memorySize: 1024
    })

    // 認証情報へのアクセス許可
    databaseCredentialsSecret.grantRead(fn);
    databaseCredentialsSecret.grantRead(host);

    const api = new aws_apigateway.RestApi(this, 'api', {
      defaultCorsPreflightOptions: {
        allowOrigins: aws_apigateway.Cors.ALL_ORIGINS,
        allowMethods: aws_apigateway.Cors.ALL_METHODS,
        allowHeaders: aws_apigateway.Cors.DEFAULT_HEADERS,
      },
    })

    api.root.addProxy({
      defaultIntegration: new aws_apigateway.LambdaIntegration(fn),
    })
  }
}