# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Rakefile for the DRACO Project
#
require 'aws-sdk-cloudformation'
require 'aws-sdk-s3'
require 'aws-sdk-rds'
require 'aws-sdk-sns'
require 'json'
require 'fileutils'
require 'pathname'
require 'pp'
require 'tempfile'
require 'yaml'

Rake.application.options.trace = false
Rake.application.options.suppress_backtrace_pattern = /^(?!#{Regexp.escape(FileUtils.pwd)}\/[^.])/

class String
    def camelize
	self.split("_").map{|p| p[0].upcase+p[1..-1].downcase}.join
    end
    def macro_case # Fix this
	self.split(/[A-Z][a-z]*/).map{|p| p.upcase}.join('_')
    end
end

# Setup each time (was a task but each task needed it)
#
begin
    roles = ['Producer', 'Consumer']
    config = YAML.load(File.open('config.yaml', &:read))
    raise "Role must be defined in config.yaml" unless $role = config['Role']
    raise "Role must be #{roles.join(' or ')}" unless roles.include? $role
    exports = config["Exports"]
    exports["DR_TOPIC_ARN"] = "arn:aws:sns:#{exports['AWS_REGION']}:#{exports['DR_ACCT']}:DracoConsumer"
    exports["PROD_TOPIC_ARN"] = "arn:aws:sns:#{exports['AWS_REGION']}:#{exports['PROD_ACCT']}:DracoProducer"
    defaults = { 
	'AWS_PROFILE' => nil, 
	'AWS_REGION' => nil, 
	'DR_ACCT' => nil, 
	'PROD_ACCT' => nil, 
	'SOURCE_BUCKET' => nil,
	'TAG_KEY' => 'DR',
	'TAG_VALUE' => 'DRSnapshotCopy'
    }
    export = defaults.merge(exports)
    msg = []
    puts("Using the following environment variables:")
    export.keys.each do |var|
	if ENV[var]
	    puts "#{var}: #{ENV[var]} (environment)"
	    next 
	end
	if exports[var]
	    puts "#{var}: #{export[var]} (config)"
	    ENV[var] = export[var] 
	else
	    msg << "Need #{var} to be set in environment or config.yaml!"
	end
    end
    TIMESTAMP = Time.now.strftime("%Y-%m-%dT%H:%M:%S")
    puts("Deployment started at: #{TIMESTAMP}")
    unless msg.empty?
	STDERR.puts msg.join("\n") 
	exit 2
    end
rescue Errno::ENOENT
    STDERR.puts("'config.yaml' not found. Copy and customize 'config.yaml.sample'")
    exit 2
rescue Exception => e
    STDERR.puts("Initialization failed: #{e.message}")
    exit 1
end

desc "Setup Bucket #{ENV['SOURCE_BUCKET']}. Allow both accounts access, setup object versioning and lifecycle"
task :setup_bucket do
    s3 = Aws::S3::Client.new(region: ENV['AWS_REGION'])
    begin
	s3.head_bucket( bucket: ENV['SOURCE_BUCKET'] )
	print "Bucket '#{ENV['SOURCE_BUCKET']}' exists, creation skipped!"
    rescue Exception => e
	print "Head Bucket failed: #{e.inspect}"
	s3.create_bucket( bucket: ENV['SOURCE_BUCKET'] )
	print "Bucket '#{ENV['SOURCE_BUCKET']}' created!"
    end
    s3.put_bucket_versioning( bucket: ENV['SOURCE_BUCKET'],
			      versioning_configuration: { status: "Enabled", mfa_delete: "Disabled" })
    puts("Versioning enabled")
    s3.put_bucket_acl({bucket: ENV['SOURCE_BUCKET'], acl: "authenticated-read"})
    puts("Authenticated read access enabled")

    lifecycle = {
	rules: [
	    {
		id: "RemovePreviousDracoCode", 
		noncurrent_version_expiration: {
		    noncurrent_days: 1, 
		}, 
		filter: {
		    prefix: "draco/", 
		}, 
		status: "Enabled", 
	    } 
	] 
    } 
    s3.put_bucket_lifecycle_configuration({ bucket: ENV['SOURCE_BUCKET'], lifecycle_configuration: lifecycle})
    puts("Lifecycle set to:\n")
    pp lifecycle
end

desc "Lint the Cloudformation Templates"
task :cfn_lint do
    %w(producer consumer wait4copy).each do |template|
	cd "cloudformation" do
	    sh "cfn-lint -t #{template}.yaml"
	end
    end
end

desc "Lint the Javascript Code"
task :es_lint do
    sh "npm run lint src/ test/"
end

task :bucket_warning do
    bucket = "draco-#{ENV['DR_ACCT']}-#{ENV['AWS_REGION']}"
    print "\nIs the Lambda code updated in S3 Bucket '#{bucket}'? (C to Continue): "
    s = STDIN.getc
    exit 2 unless s =~ /^(C|Y)/i
end

# Upload the given file to the S3 bucket and key if it has changed
#
def uploadIfChanged file, bucket, key
    s3 = Aws::S3::Client.new(region: ENV['AWS_REGION'])
    etag = `md5 -q #{file}`.chomp;
    rsp = s3.head_object(bucket: bucket, key: key) rescue { etag: '""' }
    s3etag = rsp[:etag][1..-2] # remove the double quotes
    if s3etag != etag
	File.open(file, "rb") do |f|
	    rsp = s3.put_object(bucket: bucket, key: key, body: f)
	    puts "File #{file} -> s3://#{bucket}/#{key} (version: #{rsp.version_id})"
	end
	return 1
    else
	return 0
    end
end

# If bucket in another region use "AWS_REGION=other bundle exec rake upload"
#
desc "Upload Lambda packages to S3"
task :upload => [:es_lint, :cfn_lint, :test] do
    begin
	nUpload = 0
	manifests = {
	    producer: %w(producer.js common.js),
	    consumer: %w(consumer.js common.js retention.js),
	    wait4copy: %w(wait4copy.js)
	}
	manifests.each do |package, files|
	    zipfile = Pathname.pwd + "build/#{package}.zip"
	    cd 'src', verbose: false do
		sh "zip -qu #{zipfile} #{files.join(' ')}", verbose: false rescue nil
	    end
	    nUpload += uploadIfChanged zipfile, ENV['SOURCE_BUCKET'], "draco/#{zipfile.basename}"
	    cd 'cloudformation', verbose: false do
		file = "#{package}.yaml"
		nUpload += uploadIfChanged file, ENV['SOURCE_BUCKET'], "draco/#{file}"
	    end
	end
	puts "#{nUpload} files uploaded"
    rescue
	puts $!.inspect
	exit 1
    end
end

namespace :create do
    desc "Create Producer Stack (run in Production account)"
    task :producer => :bucket_warning do
	sh "cfn-lint cloudformation/producer.yaml"
	cfn = Aws::CloudFormation::Client.new(region: ENV['AWS_REGION'])
	cfn.create_stack(
	    stack_name: "draco-producer",
	    template_body: File.read('cloudformation/producer.yaml'),
	    capabilities: ['CAPABILITY_NAMED_IAM', 'CAPABILITY_AUTO_EXPAND'],
	    parameters: [
		{ parameter_key: "DeploymentTimestamp", parameter_value: TIMESTAMP },
		{ parameter_key: "TargetAcct", parameter_value: ENV['DR_ACCT'] },
		{ parameter_key: "DrTagKey", parameter_value: ENV['TAG_KEY'] },
		{ parameter_key: "DrTagValue", parameter_value: ENV['TAG_VALUE'] }
	    ]
	);
    end
    desc "Create Consumer Stack (run in DR account)"
    task :consumer do
	sh "cfn-lint cloudformation/consumer.yaml"
	cfn = Aws::CloudFormation::Client.new(region: ENV['AWS_REGION'])
	cfn.create_stack(
	    stack_name: "draco-consumer",
	    template_body: File.read('cloudformation/consumer.yaml'),
	    capabilities: ['CAPABILITY_NAMED_IAM', 'CAPABILITY_AUTO_EXPAND'],
	    parameters: [
		{ parameter_key: "CodeBucket", parameter_value: ENV['SOURCE_BUCKET'] },
		{ parameter_key: "CodePrefix", parameter_value: 'draco/' },
		{ parameter_key: "DeploymentTimestamp", parameter_value: TIMESTAMP },
		{ parameter_key: "SourceAcct", parameter_value: ENV['PROD_ACCT'] }
	    ]
	);
    end
end

namespace :update do
    desc "Update Producer Stack (run in Production account)"
    task :producer => :bucket_warning do
	sh "cfn-lint cloudformation/producer.yaml"
	cfn = Aws::CloudFormation::Client.new(region: ENV['AWS_REGION'])
	rsp = cfn.update_stack(
	    stack_name: "draco-producer",
	    template_body: File.read('cloudformation/producer.yaml'),
	    capabilities: ['CAPABILITY_NAMED_IAM', 'CAPABILITY_AUTO_EXPAND'],
	    parameters: [
		{ parameter_key: "DeploymentTimestamp", parameter_value: TIMESTAMP },
		{ parameter_key: "TargetAcct", parameter_value: ENV['DR_ACCT'] },
		{ parameter_key: "DrTagKey", parameter_value: ENV['TAG_KEY'] },
		{ parameter_key: "DrTagValue", parameter_value: ENV['TAG_VALUE'] }
	    ]
	);
	puts("Updating: #{rsp[:stack_id].split(':')[5]}")
    end
    desc "Update Consumer Stack (run in DR account)"
    task :consumer do
	sh "cfn-lint cloudformation/consumer.yaml"
	cfn = Aws::CloudFormation::Client.new(region: ENV['AWS_REGION'])
	rsp = cfn.update_stack(
	    stack_name: "draco-consumer",
	    template_body: File.read('cloudformation/consumer.yaml'),
	    capabilities: ['CAPABILITY_NAMED_IAM', 'CAPABILITY_AUTO_EXPAND'],
	    parameters: [
		{ parameter_key: "CodeBucket", parameter_value: ENV['SOURCE_BUCKET'] },
		{ parameter_key: "CodePrefix", parameter_value: 'draco/' },
		{ parameter_key: "DeploymentTimestamp", parameter_value: TIMESTAMP },
		{ parameter_key: "SourceAcct", parameter_value: ENV['PROD_ACCT'] }
	    ]
	);
	puts("Updating: #{rsp[:stack_id].split(':')[5]}")
    end
end

namespace :event do
    desc "Send a snapshot get key event to the Consumer"
    task :snapshot_get_key, [:resource_id]  do |t, args|
	resource_id = args[:resource_id] || 'testing'
	puts "Resource ID: #{resource_id}"
	sns = Aws::SNS::Resource.new(region: ENV['AWS_REGION'])
	topic = sns.topic(ENV['DR_TOPIC_ARN'])
	event = {   'EventType': 'snapshot-get-key',
		    'SnapshotType': 'RDS',
		    'ResourceId': resource_id,
		    'ProdAcct': ENV['PROD_ACCT'],
		    'SourceArn': 'dummy' }
	topic.publish({
	    subject: 'DRACO Event',
	    message: event.to_json
	})
	puts "Sent #{event}"
    end

    desc "Send a snapshot copy complete event to the #{$role}"
    task :snapshot_copy_complete, [:snapshot_id]  do |t, args|
	rds = Aws::RDS::Client.new(region: ENV['AWS_REGION'])
	snapshot_id = args[:snapshot_id]
	puts "Snapshot: #{snapshot_id}"
	res = rds.describe_db_snapshots(db_snapshot_identifier: snapshot_id);
	snapshot_arn = res[:db_snapshots].first[:db_snapshot_arn]
	sns = Aws::SNS::Resource.new(region: ENV['AWS_REGION'])
	topic_arn = ($role == 'Producer' ? ENV['PROD_TOPIC_ARN']: ENV['DR_TOPIC_ARN'])
	topic = sns.topic(topic_arn)
	event = { 'EventType': 'snapshot-copy-completed',
		  'SnapshotType': 'RDS',
		  'SourceArn': snapshot_arn,
		  'TargetArn': 'fake' }
	topic.publish({
	    subject: 'DRACO Event',
	    message: event.to_json
	})
	puts "Sent #{$role} event: #{event}"
    end

    desc "Send a snapshot copy shared event to the Consumer"
    task :snapshot_copy_shared, [:snapshot_id]  do |t, args|
	rds = Aws::RDS::Client.new(region: ENV['AWS_REGION'])
	snapshot_id = args[:snapshot_id]
	puts "Snapshot: #{snapshot_id}"
	res = rds.describe_db_snapshots(db_snapshot_identifier: snapshot_id);
	snapshot_arn = res[:db_snapshots].first[:db_snapshot_arn]
	sns = Aws::SNS::Resource.new(region: ENV['AWS_REGION'])
	topic = sns.topic(ENV['DR_TOPIC_ARN'])
	event = {   'EventType': 'snapshot-copy-shared',
		    'SnapshotType': 'RDS',
		    'SourceArn': snapshot_arn }
	topic.publish({
	    subject: 'DRACO Event',
	    message: event.to_json
	})
	puts "Sent #{event}"
    end

    desc "Send a copy complete event to the Consumer (will notify producer to delete)"
    task :shared_copy_complete, [:snapshot_id]  do |t, args|
	snapshot_id = args[:snapshot_id]
	puts "Snapshot: #{snapshot_id}"
	sns = Aws::SNS::Resource.new(region: ENV['AWS_REGION'])
	topic = sns.topic(ENV['DR_TOPIC_ARN'])
	event = {   'EventType': 'snapshot-copy-completed',
		    'SnapshotType': 'RDS',
		    'SourceArn': snapshot_id,
		    'TargetArn': snapshot_id+'-dr' }
	topic.publish({
	    subject: 'DRACO Event',
	    message: event.to_json
	})
	puts "Sent #{event}"
    end

    desc "Send a snapshot_delete_shared event to the Producer (will notify producer to delete)"
    task :snapshot_delete_shared, [:snapshot_id]  do |t, args|
	snapshot_id = args[:snapshot_id]
	puts "Snapshot: #{snapshot_id}"
	rds = Aws::RDS::Client.new(region: ENV['AWS_REGION'])
	res = rds.describe_db_snapshots(db_snapshot_identifier: snapshot_id);
	snapshot_arn = res[:db_snapshots].first[:db_snapshot_arn]
	sns = Aws::SNS::Resource.new(region: ENV['AWS_REGION'])
	topic = sns.topic(ENV['PROD_TOPIC_ARN'])
	event = {   'EventType': 'snapshot-delete-shared',
		    'SnapshotType': 'RDS',
		    'SourceArn': snapshot_arn }
	topic.publish({
	    subject: 'DRACO Event',
	    message: event.to_json
	})
	puts "Sent #{event}"
    end

    namespace :cluster do
	desc "Send a cluster snapshot copy shared event to the Consumer"
	task :snapshot_copy_shared, [:snapshot_id]  do |t, args|
	    rds = Aws::RDS::Client.new(region: ENV['AWS_REGION'])
	    snapshot_id = args[:snapshot_id]
	    puts "Snapshot: #{snapshot_id}"
	    res = rds.describe_db_cluster_snapshots(db_cluster_snapshot_identifier: snapshot_id);
	    snapshot_arn = res[:db_cluster_snapshots].first[:db_cluster_snapshot_arn]
	    sns = Aws::SNS::Resource.new(region: ENV['AWS_REGION'])
	    topic = sns.topic(ENV['DR_TOPIC_ARN'])
	    event = {	'EventType': 'snapshot-copy-shared',
			'SnapshotType': 'RDS Cluster',
			'SourceArn': snapshot_arn }
	    topic.publish({
		subject: 'DRACO Event',
		message: event.to_json
	    })
	    puts "Sent #{event}"
	end
    end # namespace :cluster

end # namespace :event

desc "Run unit tests"
task :test do
    sh "npm test"
end

# vim: ts=8 sts=4 sw=4 noet ft=ruby
