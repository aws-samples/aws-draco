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
    puts("")
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

def get_lambda_versions
    s3 = Aws::S3::Client.new(region: ENV['AWS_REGION'])
    versions = %w(producer consumer wait4copy).map do |src|
	rsp = s3.list_object_versions(bucket: ENV['SOURCE_BUCKET'], prefix: "draco/#{src}.zip")
	latest = rsp[:versions].select{|v| v[:is_latest]}.first
	[src, latest.version_id]
    end
    return versions.to_h
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

desc "Upload Lambda packages to S3"
task :upload => :test do
    begin
    s3 = Aws::S3::Client.new(region: ENV['AWS_REGION'])
    %w(producer consumer wait4copy).each do |src|
	tf = Tempfile.new(src)
	cd src, verbose: false do
	    sh "zip -rq -x.* #{tf.path}.zip *", verbose: false
	    puts "Zipfile for #{src} created"
	end
	File.open("#{tf.path}.zip", "rb") { |f|
	    rsp = s3.put_object(bucket: ENV['SOURCE_BUCKET'], key: "draco/#{src}.zip",
			       	body: f, acl: "authenticated-read")
	    puts "Lambda #{src} version: #{rsp[:version_id]}"
	}
	File.open("#{src}.yaml", "r") { |f|
	    s3.put_object(bucket: ENV['SOURCE_BUCKET'], key: "draco/#{src}.yaml",
			  body: f, acl: "authenticated-read")
	}
	puts "#{src}.{yaml,zip} uploaded to s3://#{ENV['SOURCE_BUCKET']}/draco"
	tf.unlink
    end
    rescue
	puts $!.inspect
	exit 1
    end
end

task :get_versions do
    get_lambda_versions.each {|k,v| puts "#{k}: version: #{v}"}
end

namespace :create do
    desc "Create Producer Stack (run in Production account)"
    task :producer do
	cfn = Aws::CloudFormation::Client.new(region: ENV['AWS_REGION'])
	code_versions = get_lambda_versions
	cfn.create_stack(
	    stack_name: "draco-producer",
	    template_body: File.read('producer.yaml'),
	    capabilities: ['CAPABILITY_NAMED_IAM', 'CAPABILITY_AUTO_EXPAND'],
	    parameters: [
		{ parameter_key: "CodeBucket", parameter_value: ENV['SOURCE_BUCKET'] },
		{ parameter_key: "ProducerLambdaVersion", parameter_value: code_versions['producer'] },
		{ parameter_key: "Wait4CopyLambdaVersion", parameter_value: code_versions['wait4copy'] },
		{ parameter_key: "SourceAcct", parameter_value: ENV['PROD_ACCT'] },
		{ parameter_key: "TargetAcct", parameter_value: ENV['DR_ACCT'] },
		{ parameter_key: "DrTagKey", parameter_value: ENV['TAG_KEY'] },
		{ parameter_key: "DrTagValue", parameter_value: ENV['TAG_VALUE'] }
	    ]
	);
    end
    desc "Create Consumer Stack (run in DR account)"
    task :consumer do
	cfn = Aws::CloudFormation::Client.new(region: ENV['AWS_REGION'])
	code_versions = get_lambda_versions
	cfn.create_stack(
	    stack_name: "draco-consumer",
	    template_body: File.read('consumer.yaml'),
	    capabilities: ['CAPABILITY_NAMED_IAM', 'CAPABILITY_AUTO_EXPAND'],
	    parameters: [
		{ parameter_key: "CodeBucket", parameter_value: ENV['SOURCE_BUCKET'] },
		{ parameter_key: "ConsumerLambdaVersion", parameter_value: code_versions['consumer'] },
		{ parameter_key: "Wait4CopyLambdaVersion", parameter_value: code_versions['wait4copy'] },
		{ parameter_key: "SourceAcct", parameter_value: ENV['PROD_ACCT'] },
		{ parameter_key: "TargetAcct", parameter_value: ENV['DR_ACCT'] },
		{ parameter_key: "DrTagKey", parameter_value: ENV['TAG_KEY'] },
		{ parameter_key: "DrTagValue", parameter_value: ENV['TAG_VALUE'] }
	    ]
	);
    end
end

namespace :update do
    desc "Update Producer Stack (run in Production account)"
    task :producer do
	cfn = Aws::CloudFormation::Client.new(region: ENV['AWS_REGION'])
	code_versions = get_lambda_versions
	cfn.update_stack(
	    stack_name: "draco-producer",
	    template_body: File.read('producer.yaml'),
	    capabilities: ['CAPABILITY_NAMED_IAM', 'CAPABILITY_AUTO_EXPAND'],
	    parameters: [
		{ parameter_key: "CodeBucket", parameter_value: ENV['SOURCE_BUCKET'] },
		{ parameter_key: "ProducerLambdaVersion", parameter_value: code_versions['producer'] },
		{ parameter_key: "Wait4CopyLambdaVersion", parameter_value: code_versions['wait4copy'] },
		{ parameter_key: "SourceAcct", parameter_value: ENV['PROD_ACCT'] },
		{ parameter_key: "TargetAcct", parameter_value: ENV['DR_ACCT'] },
		{ parameter_key: "DrTagKey", parameter_value: ENV['TAG_KEY'] },
		{ parameter_key: "DrTagValue", parameter_value: ENV['TAG_VALUE'] }
	    ]
	);
    end
    desc "Update Consumer Stack (run in DR account)"
    task :consumer do
	cfn = Aws::CloudFormation::Client.new(region: ENV['AWS_REGION'])
	code_versions = get_lambda_versions
	cfn.update_stack(
	    stack_name: "draco-consumer",
	    template_body: File.read('consumer.yaml'),
	    capabilities: ['CAPABILITY_NAMED_IAM', 'CAPABILITY_AUTO_EXPAND'],
	    parameters: [
		{ parameter_key: "CodeBucket", parameter_value: ENV['SOURCE_BUCKET'] },
		{ parameter_key: "ConsumerLambdaVersion", parameter_value: code_versions['consumer'] },
		{ parameter_key: "Wait4CopyLambdaVersion", parameter_value: code_versions['wait4copy'] },
		{ parameter_key: "SourceAcct", parameter_value: ENV['PROD_ACCT'] },
		{ parameter_key: "TargetAcct", parameter_value: ENV['DR_ACCT'] },
		{ parameter_key: "DrTagKey", parameter_value: ENV['TAG_KEY'] },
		{ parameter_key: "DrTagValue", parameter_value: ENV['TAG_VALUE'] }
	    ]
	);
    end
end

namespace :event do
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
