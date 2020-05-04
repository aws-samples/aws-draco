#!/usr/bin/env ruby
#
require 'json'
require 'date'

# Generate some test data
#
prng = Random.new
default_date = '14-06-2020T22:20'
default_days = 65
end_date = ARGV[0] || default_date
if end_date !~ /^[0-9\-T:]+$/
  puts <<~USAGE
    Usage:\t#{$0} end_date numdays
    \tDate is in ISO8601 format (default #{default_date})
    \tNumber of days (default #{default_days})
  USAGE
  exit 2
end
duration = ARGV[1].to_i || default_days # days
dtend = DateTime.parse(end_date)
output = []

(1..duration).each do |ago|
  age = ago + prng.rand(-0.05..+0.05)
  dt = dtend - age
  sdt = dt.strftime("%Y-%m-%d")
  entry = {
    "age" =>  age,
    "id" =>  "pgdracotest-#{sdt}-22-20",
    "arn" =>  "arn:aws:rds:eu-west-2:166824542191:snapshot:pgdracotest-#{sdt}-22-20",
    "date" =>  dt.strftime("%Y-%m-%dT%T.%LZ"),
  }
  output.push(entry)
end
puts JSON.pretty_generate(output)
