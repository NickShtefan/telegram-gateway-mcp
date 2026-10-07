#!/bin/sh
# Trusted/reviewed bootstrap verification, not a self-authenticating download.
# Production elevation/acquisition requires the independent owner trust gate.
set -eu
PATH=/usr/bin:/bin
export PATH
LC_ALL=C
export LC_ALL
unset NODE_OPTIONS NODE_PATH ENV BASH_ENV CDPATH
fail() { printf '%s\n' '{"format_version":1,"error_code":"bootstrap_verification_failed"}' >&2; exit 1; }
[ "$#" -eq 4 ] || fail
bundle=$1
pin=$2
source_sha=$3
operation=$4
[ "$operation" = verify ] || [ "$operation" = prepare ] || fail
[ "${#pin}" -eq 64 ] && [ "${#source_sha}" -eq 40 ] || fail
case "$pin$source_sha" in *[!0-9a-f]*) fail ;; esac
case "$(/usr/bin/uname -s)" in
  Darwin) target=darwin; base=/private/tmp; stat_size() { /usr/bin/stat -f %z "$1"; }; stat_links() { /usr/bin/stat -f %l "$1"; } ;;
  Linux) target=linux; base=/tmp; stat_size() { /usr/bin/stat -c %s "$1"; }; stat_links() { /usr/bin/stat -c %h "$1"; } ;;
  *) fail ;;
esac
case "$(/usr/bin/uname -m)" in arm64|aarch64) arch=arm64 ;; x86_64) arch=x64 ;; *) fail ;; esac
[ -x /usr/bin/openssl ] || fail
regular() { [ -f "$1" ] && [ ! -L "$1" ] && [ "$(stat_links "$1")" -eq 1 ]; }
for name in manifest.tsv manifest.sig signer.der; do regular "$bundle/$name" || fail; done
[ "$(stat_size "$bundle/manifest.tsv")" -le 8192 ] && [ "$(stat_size "$bundle/manifest.sig")" -eq 384 ] && [ "$(stat_size "$bundle/signer.der")" -le 16384 ] || fail
openssl_clean() { /usr/bin/env -i PATH=/usr/bin:/bin OPENSSL_CONF=/dev/null /usr/bin/openssl "$@"; }
[ "$(openssl_clean dgst -sha256 "$bundle/signer.der" 2>/dev/null | /usr/bin/awk '{print $NF}')" = "$pin" ] || fail
stage=$(/usr/bin/mktemp -d "$base/tg-mcp-candidate.XXXXXX") || fail
keep=0
trap '[ "$keep" -eq 1 ] || /bin/rm -rf "$stage"' EXIT HUP INT TERM
# Work on private snapshots; source substitution is rechecked on copied bytes.
for name in manifest.tsv manifest.sig signer.der; do /bin/cp "$bundle/$name" "$stage/$name" || fail; /bin/chmod 600 "$stage/$name"; done
[ "$(openssl_clean dgst -sha256 "$stage/signer.der" 2>/dev/null | /usr/bin/awk '{print $NF}')" = "$pin" ] || fail
openssl_clean x509 -inform DER -in "$stage/signer.der" -pubkey -noout > "$stage/public.pem" 2>/dev/null || fail
case "$(openssl_clean rsa -pubin -in "$stage/public.pem" -text -noout 2>/dev/null)" in *'(3072 bit)'*) ;; *) fail ;; esac
openssl_clean dgst -sha256 -verify "$stage/public.pem" -signature "$stage/manifest.sig" "$stage/manifest.tsv" >/dev/null 2>&1 || fail
# Closed wire grammar and fixed role filenames; no manifest field is executed.
/usr/bin/awk -F '\t' -v source="$source_sha" -v target="$target" -v arch="$arch" '
function bad() { exit 1 }
NR==1 { if($0!="TG_MCP_RELEASE_V1") bad(); next }
NR==2 { if(NF!=2 || $1!="version" || $2!="0.2.0") bad(); next }
NR==3 { if(NF!=2 || $1!="source_sha" || $2!=source) bad(); next }
NR==4 { if(NF!=2 || $1!="platform" || $2!=target) bad(); next }
NR==5 { if(NF!=2 || $1!="architecture" || $2!=arch) bad(); next }
NR==6 { if(NF!=2 || $1!="node_version" || $2!~/^[0-9]+\.[0-9]+\.[0-9]+$/) bad(); split($2,v,"."); if(!((v[1]==22 && v[2]>=13)||v[1]==24))bad(); next }
NR>=7 && NR<=12 {
  split("node installer manifest_helper archive_helper application node_license",roles," "); split("node installer.mjs manifest.mjs archive.mjs application.tar.gz NODE_LICENSE",names," ");
  i=NR-6; max=(i==1 || i==5)?134217728:1048576;
  if(NF!=5 || $1!="file" || $2!=roles[i] || $3!=names[i] || $4!~/^[1-9][0-9]*$/ || length($4)>9 || $4>max || length($5)!=64 || $5~/[^0-9a-f]/)bad(); next }
{ bad() }
END { if(NR!=12)exit 1 }
' "$stage/manifest.tsv" || fail
node_version=$(/usr/bin/awk -F '\t' '$1=="node_version" {print $2}' "$stage/manifest.tsv")
if [ "$target" = darwin ]; then
  os_version=$(/usr/bin/sw_vers -productVersion) || fail
  /usr/bin/awk -v os="$os_version" -v runtime="$node_version" 'BEGIN {split(os,o,".");split(runtime,n,".");if(o[1]<13 || (n[1]==24 && o[1]==13 && o[2]<5))exit 1}' || fail
fi
for name in node installer.mjs manifest.mjs archive.mjs application.tar.gz NODE_LICENSE; do
  regular "$bundle/$name" || fail
  expected_size=$(/usr/bin/awk -F '\t' -v n="$name" '$1=="file" && $3==n {print $4}' "$stage/manifest.tsv")
  expected_sha=$(/usr/bin/awk -F '\t' -v n="$name" '$1=="file" && $3==n {print $5}' "$stage/manifest.tsv")
  [ "$(stat_size "$bundle/$name")" -eq "$expected_size" ] || fail
  /bin/cp "$bundle/$name" "$stage/$name" || fail
  /bin/chmod 600 "$stage/$name"
  [ "$(stat_size "$stage/$name")" -eq "$expected_size" ] || fail
  [ "$(openssl_clean dgst -sha256 "$stage/$name" 2>/dev/null | /usr/bin/awk '{print $NF}')" = "$expected_sha" ] || fail
done
/bin/chmod 700 "$stage/node"
# Node/npm in the caller's environment are never used.
if [ "$operation" = verify ]; then
  /usr/bin/env -i PATH=/usr/bin:/bin "$stage/node" "$stage/installer.mjs" --version 0.2.0 --source-sha "$source_sha" --signer-sha256 "$pin" || fail
else
  /usr/bin/env -i PATH=/usr/bin:/bin "$stage/node" "$stage/installer.mjs" --version 0.2.0 --source-sha "$source_sha" --signer-sha256 "$pin" --extract || fail
  keep=1
  printf '{"format_version":1,"phase":"candidate_staged","candidate":"%s","installed":false}\n' "$stage"
fi
