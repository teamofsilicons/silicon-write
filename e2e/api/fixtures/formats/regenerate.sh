#!/usr/bin/env bash
# Regenerates the file-format fixtures read by e2e/api/formats.test.mjs.
#
# Sources (hand-written, kept as they are):
#   rich.md            the rich document: headings, bold/italic/strike/code, a link, nested and
#                      ordered lists, a checklist, a table, a quote, maths, a code block, a footnote
#   embedded-image.md  a heading, text, one picture (dot.png), text
#   pictures.md        a picture in a table cell, and a Word drawing (EMF)
#   styled.html        text colour, highlight, underline and strikethrough on a web page
#   plain.txt          plain text with a line break and a blank line
#   dot.png            a deterministic 8x8 red PNG (made here when missing); dot.{jpg,gif,webp} are
#                      made from it
#
# Made from them:
#   pandoc       rich.docx, rich.html (MathML), embedded-image.docx, embedded-image.html (picture inline
#                as a data: URI), pictures.docx (the EMF drawn from dot.png by LibreOffice)
#   LibreOffice  rich.{odt,rtf,doc,pdf} and embedded-image.{odt,rtf,doc} from the pandoc .docx, so they
#                look like real office exports; styled.docx from styled.html (Word runs with w:color,
#                w:shd and w:u, as LibreOffice and Word write them)
#
# The tests only READ these files. Run this to rebuild them: needs pandoc and LibreOffice at
# /Applications/LibreOffice.app (or set SOFFICE / PANDOC).
set -euo pipefail
cd "$(dirname "$0")"

SOFFICE="${SOFFICE:-/Applications/LibreOffice.app/Contents/MacOS/soffice}"
PANDOC="${PANDOC:-pandoc}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
profile="$work/lo-profile"
mkdir -p "$profile"

if [ ! -f dot.png ]; then
  node -e '
  const zlib=require("zlib"),fs=require("fs");const W=8,H=8;
  const raw=Buffer.alloc(H*(1+W*3));
  for(let y=0;y<H;y++){const o=y*(1+W*3);raw[o]=0;for(let x=0;x<W;x++){const p=o+1+x*3;raw[p]=220;raw[p+1]=40;raw[p+2]=40;}}
  function crc32(b){let c=~0;for(let i=0;i<b.length;i++){c^=b[i];for(let k=0;k<8;k++)c=(c>>>1)^(0xEDB88320&-(c&1));}return ~c;}
  function chunk(t,d){const l=Buffer.alloc(4);l.writeUInt32BE(d.length);const tb=Buffer.from(t);const cr=Buffer.alloc(4);cr.writeUInt32BE(crc32(Buffer.concat([tb,d]))>>>0);return Buffer.concat([l,tb,d,cr]);}
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(W,0);ihdr.writeUInt32BE(H,4);ihdr[8]=8;ihdr[9]=2;
  fs.writeFileSync("dot.png",Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk("IHDR",ihdr),chunk("IDAT",zlib.deflateSync(raw)),chunk("IEND",Buffer.alloc(0))]));
  '
fi

soffice() { # soffice <format> <input>  -> $work/<stem>.<format>
  "$SOFFICE" --headless --norestore -env:UserInstallation="file://$profile" \
    --convert-to "$1" --outdir "$work" "$2" >/dev/null 2>&1
}

# pandoc
"$PANDOC" rich.md -o rich.docx
"$PANDOC" rich.md -s --math-method=mathml -o rich.html
cp dot.png "$work/dot.png"
"$PANDOC" embedded-image.md --resource-path=".:$work" -o embedded-image.docx
"$PANDOC" embedded-image.md -s --embed-resources --resource-path=".:$work" -o embedded-image.html

# LibreOffice, from the pandoc Word files
for fmt in odt rtf doc pdf; do
  soffice "$fmt" rich.docx
  cp "$work/rich.$fmt" "rich.$fmt"
done
for fmt in odt rtf doc; do
  soffice "$fmt" embedded-image.docx
  cp "$work/embedded-image.$fmt" "embedded-image.$fmt"
done
soffice "docx:MS Word 2007 XML" styled.html
cp "$work/styled.docx" styled.docx

# pictures.docx: a picture in a table cell and a Word drawing (EMF, which browsers can't show; LibreOffice draws it).
soffice emf "$work/dot.png"
"$PANDOC" pictures.md --resource-path=".:$work" -o pictures.docx

# The same dot as JPEG, GIF and WebP, for image uploads (sips ships with macOS; cwebp or ImageMagick for WebP).
sips -s format jpeg dot.png --out dot.jpg >/dev/null
sips -s format gif dot.png --out dot.gif >/dev/null
if command -v cwebp >/dev/null; then cwebp -quiet -lossless dot.png -o dot.webp; else magick dot.png dot.webp; fi

echo "Regenerated: rich.{docx,html,odt,rtf,doc,pdf}, embedded-image.{docx,html,odt,rtf,doc}, styled.docx, pictures.docx, dot.{jpg,gif,webp}"
