#!/usr/bin/env python3
"""Add only Write's two production DNS records, preserving the Namecheap zone.

Dry-run by default. Credentials stay in memory; snapshots contain DNS data only.
Namecheap replaces the whole zone and offers no compare-and-swap operation: do
not run another DNS writer concurrently with this helper.
"""

import argparse
from collections import Counter
import datetime
import ipaddress
import json
import os
from pathlib import Path
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid
import xml.etree.ElementTree as ET


DOMAIN = "teamofsilicons.com"
ENDPOINT = "https://api.namecheap.com/xml.response"
OWNED_HOSTS = {"api.write", "write"}
REPO = Path(__file__).resolve().parents[1]


class DNSFailure(Exception):
    pass


def parse_response(data, command):
    try:
        root = ET.fromstring(data)
    except ET.ParseError:
        raise DNSFailure("Namecheap returned invalid XML") from None
    errors = root.findall(".//{*}Error")
    if root.get("Status") != "OK" or errors:
        # Error text may echo request values. Print only the nonsecret codes.
        codes = ", ".join(e.get("Number", "unknown") for e in errors)
        raise DNSFailure(f"Namecheap rejected {command} (error codes: {codes or 'unknown'})")
    response = root.find("{*}CommandResponse")
    if response is None or response.get("Type") != command:
        raise DNSFailure("Namecheap returned an unexpected command response")
    return response


class Namecheap:
    def __init__(self):
        path = Path.home() / ".config/namecheap-cli/config.json"
        try:
            config = json.loads(path.read_text())
            credentials = config["credentials"]
            if config.get("sandbox"):
                raise DNSFailure("Namecheap CLI is configured for sandbox, not production")
            self.auth = {
                key: credentials[source]
                for key, source in (
                    ("ApiUser", "apiUser"), ("ApiKey", "apiKey"),
                    ("UserName", "userName"), ("ClientIp", "clientIp"),
                )
            }
            if not all(isinstance(value, str) and value for value in self.auth.values()):
                raise ValueError
        except (OSError, ValueError, KeyError, TypeError):
            raise DNSFailure("Cannot read complete Namecheap credentials from the CLI config") from None

    def request(self, command, values=None):
        params = dict(self.auth, Command=command, SLD="teamofsilicons", TLD="com")
        params.update(values or {})
        request = urllib.request.Request(
            ENDPOINT, data=urllib.parse.urlencode(params).encode(), method="POST",
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                data = response.read()
        except (urllib.error.URLError, TimeoutError, OSError):
            # Do not retry a write with an unknown outcome, or log request data.
            raise DNSFailure(f"Namecheap {command} request failed; inspect current DNS before retrying") from None
        return parse_response(data, command)

    def get_zone(self):
        response = self.request("namecheap.domains.dns.getHosts")
        result = response.find("{*}DomainDNSGetHostsResult")
        if result is None or result.get("Domain") != DOMAIN:
            raise DNSFailure("Namecheap returned an unexpected domain")
        if result.get("IsUsingOurDNS", "").lower() != "true":
            raise DNSFailure("The domain is not using Namecheap DNS")
        email_type = result.get("EmailType")
        if email_type not in {"MX", "MXE", "FWD", "OX"}:
            raise DNSFailure("Cannot safely preserve the domain's EmailType")
        records = [dict(child.attrib) for child in result if child.tag.rsplit("}", 1)[-1].lower() == "host"]
        if not records:
            raise DNSFailure("Refusing to replace an unexpectedly empty zone")
        for record in records:
            if not all(key in record for key in ("Name", "Type", "Address", "TTL", "MXPref")):
                raise DNSFailure("DNS record is missing required fields")
            if record.get("IsActive", "true").lower() != "true" or record.get("IsDDNSEnabled", "false").lower() != "false":
                raise DNSFailure("Cannot safely preserve disabled or dynamic DNS records")
            # Namecheap derives MX1/MX metadata for its custom-mail records from
            # EmailType. Preserve order and verify these fields again afterward.
            mail_label = (
                email_type == "MX" and record["Type"] == "MX"
                and record.get("AssociatedAppTitle") == "MX"
                and re.fullmatch(r"MX\d+", record.get("FriendlyName", ""))
            )
            if (record.get("FriendlyName") or record.get("AssociatedAppTitle")) and not mail_label:
                raise DNSFailure("Cannot safely preserve record labels or associated applications")
            if set(record) - {"HostId", "Name", "Type", "Address", "MXPref", "TTL", "IsActive", "IsDDNSEnabled", "FriendlyName", "AssociatedAppTitle"}:
                raise DNSFailure("DNS record contains unsupported metadata")
        return {"domain": DOMAIN, "email_type": email_type, "records": records}

    def set_zone(self, zone):
        values = {"EmailType": zone["email_type"]}
        for index, record in enumerate(zone["records"], 1):
            for source, target in (("Name", "HostName"), ("Type", "RecordType"), ("Address", "Address"), ("TTL", "TTL")):
                values[f"{target}{index}"] = record[source]
            if record["Type"] == "MX":
                values[f"MXPref{index}"] = record["MXPref"]
        response = self.request("namecheap.domains.dns.setHosts", values)
        result = response.find("{*}DomainDNSSetHostsResult")
        if result is None or result.get("Domain") != DOMAIN or result.get("IsSuccess", "").lower() != "true":
            raise DNSFailure("Namecheap did not confirm the zone update; inspect DNS before retrying")


def name(record):
    return record["Name"].lower().rstrip(".")


def record_key(record):
    # Host IDs are replaced by setHosts. Empty labels and default flags are not.
    return tuple(record.get(key, default) for key, default in (
        ("Name", ""), ("Type", ""), ("Address", ""), ("TTL", ""), ("MXPref", "10"),
        ("IsActive", "true"), ("IsDDNSEnabled", "false"), ("FriendlyName", ""), ("AssociatedAppTitle", ""),
    ))


def same_zone(left, right):
    return left["email_type"] == right["email_type"] and Counter(map(record_key, left["records"])) == Counter(map(record_key, right["records"]))


def plan(zone, api_ip, web_cname):
    expected = {"api.write": ("A", api_ip), "write": ("CNAME", web_cname)}
    additions = []
    for hostname, (kind, address) in expected.items():
        existing = [record for record in zone["records"] if name(record) == hostname]
        if existing:
            if len(existing) != 1 or existing[0]["Type"] != kind or existing[0]["Address"].lower().rstrip(".") != address.lower().rstrip("."):
                raise DNSFailure(f"Conflicting record exists for {hostname}.{DOMAIN}; no changes made")
        else:
            additions.append({"Name": hostname, "Type": kind, "Address": address, "TTL": "300", "MXPref": "10"})
    return dict(zone, records=zone["records"] + additions), additions


def verify(before, after, api_ip, web_cname):
    if before["email_type"] != after["email_type"]:
        raise DNSFailure("VERIFY FAILED: EmailType changed; inspect snapshots before any further write")
    original = Counter(record_key(r) for r in before["records"] if name(r) not in OWNED_HOSTS)
    preserved = Counter(record_key(r) for r in after["records"] if name(r) not in OWNED_HOSTS)
    if original != preserved:
        raise DNSFailure("VERIFY FAILED: unrelated DNS records changed; inspect snapshots before any further write")
    _, missing = plan(after, api_ip, web_cname)
    if missing:
        raise DNSFailure("VERIFY FAILED: Write DNS records are missing")
    for old in before["records"]:
        if name(old) in OWNED_HOSTS and not any(record_key(old) == record_key(new) for new in after["records"]):
            raise DNSFailure("VERIFY FAILED: an existing Write record changed")


def snapshot(directory, filename, value):
    path = directory / filename
    with path.open("x") as out:
        json.dump(value, out, indent=2)
        out.write("\n")
    path.chmod(0o600)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--api-ip", required=True, help="Write stack Elastic IPv4 address")
    parser.add_argument("--web-cname", required=True, help="Vercel-assigned CNAME for write.teamofsilicons.com")
    parser.add_argument("--apply", action="store_true", help="Apply the reviewed additions; default only reads and snapshots")
    args = parser.parse_args()
    try:
        api_ip = ipaddress.IPv4Address(args.api_ip)
    except ipaddress.AddressValueError:
        raise DNSFailure("--api-ip must be a public IPv4 address") from None
    if not api_ip.is_global:
        raise DNSFailure("--api-ip must be a public IPv4 address")
    web_cname = args.web_cname.lower().rstrip(".")
    if not re.fullmatch(r"[a-z0-9-]+\.vercel-dns-\d+\.com", web_cname):
        raise DNSFailure("--web-cname must be the project's assigned vercel-dns hostname")
    os.umask(0o077)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    directory = REPO / ".dev/production" / f"dns-{stamp}-{uuid.uuid4().hex[:8]}"
    directory.mkdir(parents=True, mode=0o700)
    client = Namecheap()
    before = client.get_zone()
    snapshot(directory, "before.json", before)
    planned, additions = plan(before, str(api_ip), web_cname)
    snapshot(directory, "planned.json", planned)
    print(f"Snapshot: {directory}")
    print(f"Preserving {len(before['records'])} existing records and EmailType={before['email_type']}")
    for record in additions:
        print(f"Add {record['Name']}.{DOMAIN} {record['Type']} {record['Address']} TTL={record['TTL']}")
    if not args.apply:
        print("Dry run complete; no DNS changes made.")
        return
    if additions:
        current = client.get_zone()
        snapshot(directory, "preapply.json", current)
        if not same_zone(before, current):
            raise DNSFailure("DNS changed since the snapshot; no update submitted")
        client.set_zone(planned)
    after = client.get_zone()
    snapshot(directory, "after.json", after)
    verify(before, after, str(api_ip), web_cname)
    print(f"Verified {len(after['records'])} records; Write targets match, unrelated records and EmailType are unchanged.")


if __name__ == "__main__":
    try:
        main()
    except DNSFailure as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
