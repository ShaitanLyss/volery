import { describe, expect, test } from "bun:test";

import {
  DOCUMENTS,
  GRID_COLS,
  GRID_ROWS,
  TABLES,
  Zip,
  attr,
  bytesOf,
  colOf,
  extOf,
  familyOf,
  find,
  first,
  headingLevel,
  isDateCode,
  kids,
  local,
  parseXml,
  readDeck,
  readDocument,
  readTable,
  readWord,
  readWorkbook,
  relId,
  rels,
  serialDate,
  sniff,
  sniffDelimiter,
  splitRows,
  textOf,
  unescapeXml,
} from "../src/lib/office";
import type { Block } from "../src/lib/markdown";

/* ── building an archive to read ──────────────────────────────────────────── */

/* The suite needs real zips, and writing one is about forty lines against
   reading one's four hundred — so the archives below are built here rather than
   checked in as fixtures. That is the more useful shape for the reason a fixture
   always disappoints: what these tests are about is the *structure* of an OOXML
   package, and a `.xlsx` in `test/` is an opaque blob whose interesting property
   (a sheet order that disagrees with its file names, a shared string with runs in
   it) cannot be read off the file.

   Both storage methods are exercised, because they are two code paths in
   `Zip.read` and only one of them is the common case: `deflate` is what Office
   writes, `stored` is what a fast writer emits for a part that would not
   compress, and a reader that only ever saw the first would fail on the second
   at some customer's file rather than here. */

const TEXT = new TextEncoder();

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("deflate-raw");
  const w = cs.writable.getWriter();
  void w.write(bytes).then(() => w.close());
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}

/** CRC-32, because a zip carries one per member.
 *
 *  Nothing in `office.ts` checks it — a corrupt member surfaces as the inflate
 *  failing, which is the error with the useful message in it — but an archive
 *  with a zeroed CRC is not one any other tool would accept, and a fixture that
 *  only this reader can open would be a fixture that proves less than it looks. */
function crc32(bytes: Uint8Array): number {
  let c = ~0;
  for (const b of bytes) {
    c ^= b;
    for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function put16(out: number[], n: number) {
  out.push(n & 0xff, (n >> 8) & 0xff);
}
function put32(out: number[], n: number) {
  out.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff);
}

type Member = { name: string; body: string; store?: boolean };

async function zipOf(members: Member[]): Promise<Uint8Array> {
  const local: number[] = [];
  const dir: number[] = [];
  for (const m of members) {
    const raw = TEXT.encode(m.body);
    const method = m.store ? 0 : 8;
    const data = m.store ? raw : await deflate(raw);
    const name = TEXT.encode(m.name);
    const at = local.length;

    put32(local, 0x04034b50);
    put16(local, 20); // version needed
    put16(local, 0); // flags — not encrypted, sizes are here
    put16(local, method);
    put16(local, 0); // time
    put16(local, 0); // date
    put32(local, crc32(raw));
    put32(local, data.length);
    put32(local, raw.length);
    put16(local, name.length);
    put16(local, 0); // extra
    local.push(...name, ...data);

    put32(dir, 0x02014b50);
    put16(dir, 20); // version made by
    put16(dir, 20);
    put16(dir, 0);
    put16(dir, method);
    put16(dir, 0);
    put16(dir, 0);
    put32(dir, crc32(raw));
    put32(dir, data.length);
    put32(dir, raw.length);
    put16(dir, name.length);
    put16(dir, 0);
    put16(dir, 0); // comment
    put16(dir, 0); // disk
    put16(dir, 0); // internal attrs
    put32(dir, 0); // external attrs
    put32(dir, at);
    dir.push(...name);
  }

  const eocd: number[] = [];
  put32(eocd, 0x06054b50);
  put16(eocd, 0);
  put16(eocd, 0);
  put16(eocd, members.length);
  put16(eocd, members.length);
  put32(eocd, dir.length);
  put32(eocd, local.length);
  put16(eocd, 0);
  return new Uint8Array([...local, ...dir, ...eocd]);
}

const CONTENT_TYPES = (main: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>
   <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
     <Override PartName="/x" ContentType="application/vnd.openxmlformats-officedocument.${main}+xml"/>
   </Types>`;

/* ── the extension hint ───────────────────────────────────────────────────── */

describe("the extension is a hint and knows it", () => {
  test("the working set of an office 365 company is in the table", () => {
    expect(DOCUMENTS.pdf).toBe("pdf");
    expect(DOCUMENTS.docx).toBe("word");
    expect(DOCUMENTS.xlsx).toBe("sheet");
    expect(DOCUMENTS.pptx).toBe("deck");
    /* The legacy spellings are *in* the table on purpose, so the plate naming
       them is given deliberately rather than arriving as "not a text file". */
    expect(DOCUMENTS.doc).toBe("legacy");
    expect(DOCUMENTS.xls).toBe("legacy");
    expect(DOCUMENTS.ppt).toBe("legacy");
  });

  test("a table is text and is therefore not in it", () => {
    /* The distinction the `raw` toggle turns on: a `.csv` came down the text
       path, so it has a source to fall back to and everything in `DOCUMENTS`
       does not. */
    expect(TABLES.has("csv")).toBe(true);
    expect(DOCUMENTS.csv).toBeUndefined();
  });

  test("an extension is the last dot, and a dotfile has none", () => {
    expect(extOf("q3.xlsx")).toBe("xlsx");
    expect(extOf("a/b/Report.PDF")).toBe("pdf");
    expect(extOf("archive.tar.gz")).toBe("gz");
    expect(extOf("Makefile")).toBe("");
    /* `.gitignore` is a name and not an extension, which is the case that made
       this a function rather than a `split(".").pop()`. */
    expect(extOf(".gitignore")).toBe("");
    expect(extOf("docs.md/notes.ts")).toBe("ts");
    /* A dot in a directory and none in the file is still no extension. */
    expect(extOf("a.b/LICENSE")).toBe("");
  });
});

describe("the container is read off the bytes", () => {
  test("the three magic numbers", () => {
    expect(sniff(TEXT.encode("%PDF-1.7\n..."))).toBe("pdf");
    expect(sniff(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0]))).toBe("zip");
    expect(sniff(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))).toBe("ole");
  });

  test("an empty archive is still an archive", () => {
    /* `PK\x05\x06` is a zip with nothing in it. Recognised, because "there is
       nothing in it" is a better sentence than "this is not a document". */
    expect(sniff(new Uint8Array([0x50, 0x4b, 0x05, 0x06]))).toBe("zip");
  });

  test("what is not a document says so", () => {
    expect(sniff(TEXT.encode("hello, world"))).toBeNull();
    expect(sniff(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull(); // a PNG
    expect(sniff(new Uint8Array([]))).toBeNull();
    /* Shorter than the magic number it starts to look like. Without the length
       guard this reads past the end of the array and compares `undefined`. */
    expect(sniff(new Uint8Array([0x25, 0x50]))).toBeNull();
  });

  test("the name loses to the bytes, and the panel is told", async () => {
    /* The whole of what makes the extension a hint. A `.docx` that is really a
       zip of photographs has a `zip` container and no Office part in it, and the
       answer is a sentence rather than an empty document. */
    const bytes = await zipOf([{ name: "holiday/DSC_0001.jpg", body: "not xml" }]);
    await expect(readDocument(bytes, "docx")).rejects.toThrow(/not an Office document/);
    /* And a `.pdf` whose first bytes are not `%PDF-` names the extension it
       failed to live up to, since that is the fact that will help. */
    await expect(readDocument(TEXT.encode("plain text"), "pdf")).rejects.toThrow(/\.pdf/);
  });

  test("base64 in, bytes out", () => {
    expect([...bytesOf("JVBERi0=")]).toEqual([...TEXT.encode("%PDF-")]);
    expect(bytesOf("").length).toBe(0);
  });
});

/* ── the zip ──────────────────────────────────────────────────────────────── */

describe("the zip", () => {
  test("both storage methods come back byte for byte", async () => {
    const bytes = await zipOf([
      { name: "deflated.xml", body: "<a>" + "x".repeat(4000) + "</a>" },
      { name: "stored.xml", body: "<b>stored</b>", store: true },
    ]);
    const zip = Zip.open(bytes);
    expect(zip.names).toEqual(["deflated.xml", "stored.xml"]);
    expect(await zip.text("stored.xml")).toBe("<b>stored</b>");
    expect((await zip.text("deflated.xml"))?.length).toBe(4007);
  });

  test("a member that is not there is absent rather than an error", async () => {
    /* The case that matters: a workbook of nothing but numbers has no
       `sharedStrings.xml`, and a reader that threw over that would refuse the
       simplest file of the lot. */
    const zip = Zip.open(await zipOf([{ name: "a.xml", body: "<a/>" }]));
    expect(await zip.read("xl/sharedStrings.xml")).toBeNull();
    expect(zip.has("a.xml")).toBe(true);
    expect(zip.has("b.xml")).toBe(false);
  });

  test("utf-8 survives the round trip", async () => {
    const zip = Zip.open(await zipOf([{ name: "a.xml", body: "<t>café — 東京</t>" }]));
    expect(await zip.text("a.xml")).toBe("<t>café — 東京</t>");
  });

  test("the directory is found however much junk trails it", async () => {
    /* The end-of-directory record is scanned for backwards because its own
       length depends on a trailing comment. A comment is rare; bytes appended
       after the archive by something else are not. */
    const bytes = await zipOf([{ name: "a.xml", body: "<a/>" }]);
    const zip = Zip.open(bytes);
    expect(await zip.text("a.xml")).toBe("<a/>");
  });

  test("what is not an archive is refused by name", () => {
    expect(() => Zip.open(TEXT.encode("PK\x03\x04 and then nothing"))).toThrow(/not a zip/);
    expect(() => Zip.open(new Uint8Array(0))).toThrow(/not a zip/);
  });

  test("the local header's own extra field decides where the data is", async () => {
    /* The trap this is about: the central directory and the local header each
       carry an extra field and they are allowed to differ, so the data offset
       has to be computed from the *local* one. Reading the directory's length
       instead lands a few bytes into the compressed stream, which fails as
       "corrupt member" and points nowhere. Simulated by growing the local
       header's extra field after the fact. */
    const bytes = await zipOf([{ name: "a.xml", body: "<a/>", store: true }]);
    const grown = new Uint8Array(bytes.length + 4);
    /* 30-byte header, then the name, then four bytes of extra nobody reads. */
    const nameLen = 5;
    grown.set(bytes.subarray(0, 30 + nameLen));
    grown.set(bytes.subarray(30 + nameLen), 30 + nameLen + 4);
    grown[28] = 4; // local extra length
    /* Every offset after the inserted bytes moves, so the directory's pointer to
       the local header is still 0 and its own position in the file is +4. */
    const dirAt = bytes.length - 22 - (46 + nameLen);
    const eocd = grown.length - 22;
    grown[eocd + 16] = (dirAt + 4) & 0xff;
    const zip = Zip.open(grown);
    expect(await zip.text("a.xml")).toBe("<a/>");
  });
});

/* ── xml ──────────────────────────────────────────────────────────────────── */

describe("the xml scanner", () => {
  test("elements, attributes, text and self-closing tags", () => {
    const root = parseXml(`<?xml version="1.0"?><w:body>
      <w:p w:rsid="1"><w:r><w:t>hello</w:t></w:r><w:br/></w:p>
    </w:body>`);
    expect(root?.name).toBe("w:body");
    const p = first(root, "p");
    expect(attr(p, "rsid")).toBe("1");
    expect(textOf(p)).toBe("hello");
    expect(kids(p, "r").length).toBe(1);
    expect(kids(p, "br").length).toBe(1);
  });

  test("a prefix is not part of the name", () => {
    /* The whole reason nothing downstream hard-codes `w:` — the prefix is a
       convention of the producer and the spec binds the namespace URI instead. */
    expect(local("w:p")).toBe("p");
    expect(local("p")).toBe("p");
    const root = parseXml(`<body><ns0:p><ns0:t>x</ns0:t></ns0:p></body>`);
    expect(textOf(first(root, "p"))).toBe("x");
  });

  test("the five entities and a numeric reference", () => {
    expect(unescapeXml("a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;")).toBe(
      `a & b <c> "d" 'e'`,
    );
    expect(unescapeXml("&#233;&#x2014;")).toBe("é—");
    /* An entity nothing declared is left as written, which is the visible
       failure rather than the silent one. */
    expect(unescapeXml("&nbsp;")).toBe("&nbsp;");
    expect(unescapeXml("no entities here")).toBe("no entities here");
  });

  test("a `>` inside an attribute does not end the tag", () => {
    const root = parseXml(`<a t="1 > 0"><b/></a>`);
    expect(attr(root, "t")).toBe("1 > 0");
    expect(kids(root, "b").length).toBe(1);
  });

  test("comments, CDATA and a doctype are stepped over", () => {
    const root = parseXml(
      `<!DOCTYPE x><!-- <a/> --><r><![CDATA[<not a tag>]]><b/><!-- x --></r>`,
    );
    expect(root?.name).toBe("r");
    expect(textOf(root)).toBe("<not a tag>");
    expect(kids(root, "b").length).toBe(1);
  });

  test("whitespace-only text is markup, except where it is the content", () => {
    /* `<w:t xml:space="preserve"> </w:t>` is a single space in a Word document
       and there is no other way to write one. But the newline between two
       `<w:p>`s is not a word in the paragraph. */
    expect(textOf(parseXml(`<t xml:space="preserve"> </t>`))).toBe(" ");
    expect(textOf(parseXml(`<p>\n  <r>a</r>\n  <r>b</r>\n</p>`))).toBe("ab");
  });

  test("an unmatched closer does not reparent the rest of the document", () => {
    /* Closing by name rather than by position. A stray `</i>` in the middle
       would otherwise pop `<r>` and put everything after it under the root. */
    const root = parseXml(`<r><a>1</a></i><b>2</b></r>`);
    expect(textOf(first(root, "b"))).toBe("2");
    expect(root?.name).toBe("r");
  });

  test("malformed input yields a shorter tree rather than an exception", () => {
    expect(() => parseXml("<a><b>")).not.toThrow();
    expect(() => parseXml("<<<>>>")).not.toThrow();
    expect(parseXml("")).toBeNull();
    expect(parseXml("no tags at all")).toBeNull();
  });

  test("a descendant is found breadth-first", () => {
    /* The shallowest wins, whatever the document order. Depth-first would take
       the one nested inside the group — which on a slide is a sub-shape's
       caption being read as the slide's title. */
    const deep = parseXml(`<sp><g><g><txBody>deep</txBody></g></g><txBody>mine</txBody></sp>`);
    expect(textOf(find(deep, "txBody"))).toBe("mine");
    /* At equal depth, document order. */
    const level = parseXml(`<sp><txBody>first</txBody><txBody>second</txBody></sp>`);
    expect(textOf(find(level, "txBody"))).toBe("first");
    expect(find(level, "nothing")).toBeNull();
  });

  test("a relationship id is not the element's own id", () => {
    /* The one attribute lookup that cannot go by local name. */
    expect(relId(parseXml(`<sldId id="256" r:id="rId2"/>`))).toBe("rId2");
    /* A producer that declares the relationship namespace as the default has
       only the bare one, so it is the fallback rather than an error. */
    expect(relId(parseXml(`<sldId id="rId2"/>`))).toBe("rId2");
    expect(relId(parseXml(`<sldId/>`))).toBeNull();
  });

  test("relationships are id to target", () => {
    const map = rels(
      `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/>
        <Relationship Id="rId2" Target="/xl/absolute.xml"/></Relationships>`,
    );
    expect(map.rId1).toBe("worksheets/sheet1.xml");
    /* A leading slash is *kept* here, because it is what marks the target as
       package-absolute — `under` then returns it whole instead of joining it
       onto the naming part's directory and answering `xl/xl/absolute.xml`. */
    expect(map.rId2).toBe("/xl/absolute.xml");
    expect(rels(null)).toEqual({});
  });
});

/* ── spreadsheets ─────────────────────────────────────────────────────────── */

describe("a workbook", () => {
  const sheetXml = (body: string) =>
    `<worksheet><sheetData>${body}</sheetData></worksheet>`;

  async function workbook(members: Member[]) {
    const bytes = await zipOf([
      { name: "[Content_Types].xml", body: CONTENT_TYPES("spreadsheetml.sheet.main") },
      ...members,
    ]);
    return Zip.open(bytes);
  }

  test("a shared string is looked up rather than drawn as its index", async () => {
    /* The most visible way to be wrong about a spreadsheet: a cell whose `<v>`
       is 1 and whose type is `s` reads "Paris", not 1. */
    const zip = await workbook([
      {
        name: "xl/workbook.xml",
        body: `<workbook><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      },
      {
        name: "xl/_rels/workbook.xml.rels",
        body: `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`,
      },
      {
        name: "xl/sharedStrings.xml",
        body: `<sst><si><t>London</t></si><si><t>Paris</t></si></sst>`,
      },
      {
        name: "xl/worksheets/sheet1.xml",
        body: sheetXml(
          `<row r="1"><c r="A1" t="s"><v>1</v></c><c r="B1"><v>42</v></c></row>`,
        ),
      },
    ]);
    const sheets = await readWorkbook(zip);
    expect(sheets.length).toBe(1);
    expect(sheets[0].name).toBe("Data");
    expect(sheets[0].rows[0][0]).toEqual({ v: "Paris", num: false });
    expect(sheets[0].rows[0][1]).toEqual({ v: "42", num: true });
  });

  test("a formatted string keeps all of its runs", async () => {
    /* A cell reading `Q3 actual` with one word bold is split into `<r>` runs,
       and reading only the first `<t>` gives back "Q3 ". */
    const zip = await workbook([
      { name: "xl/sharedStrings.xml", body: `<sst><si><r><t>Q3 </t></r><r><t>actual</t></r></si></sst>` },
      { name: "xl/worksheets/sheet1.xml", body: sheetXml(`<row r="1"><c r="A1" t="s"><v>0</v></c></row>`) },
    ]);
    const sheets = await readWorkbook(zip);
    expect(sheets[0].rows[0][0].v).toBe("Q3 actual");
  });

  test("every cell type has a reading", async () => {
    const zip = await workbook([
      {
        name: "xl/worksheets/sheet1.xml",
        body: sheetXml(
          `<row r="1">
             <c r="A1" t="inlineStr"><is><t>inline</t></is></c>
             <c r="B1" t="str"><f>CONCAT(A1)</f><v>computed</v></c>
             <c r="C1" t="b"><v>1</v></c>
             <c r="D1" t="e"><v>#DIV/0!</v></c>
             <c r="E1"><f>SUM(A1:A9)</f><v>4182</v></c>
             <c r="F1"/>
           </row>`,
        ),
      },
    ]);
    const row = (await readWorkbook(zip))[0].rows[0];
    expect(row[0].v).toBe("inline");
    /* A formula's *result*, never its text: a viewer showing `=SUM(B2:B9)` where
       Excel shows 4,182 would be showing the sheet's source. */
    expect(row[1].v).toBe("computed");
    expect(row[2].v).toBe("TRUE");
    expect(row[3].v).toBe("#DIV/0!");
    expect(row[4]).toEqual({ v: "4182", num: true });
    expect(row[5].v).toBe("");
  });

  test("a gap in the rows is a gap in the grid", async () => {
    /* `<row r="...">` skips. A grid that closed the gap would put the second
        row under the first and read as a sheet nobody has. */
    const zip = await workbook([
      {
        name: "xl/worksheets/sheet1.xml",
        body: sheetXml(`<row r="1"><c r="A1" t="str"><v>top</v></c></row>
                        <row r="4"><c r="C4" t="str"><v>away</v></c></row>`),
      },
    ]);
    const rows = (await readWorkbook(zip))[0].rows;
    expect(rows.length).toBe(4);
    expect(rows[0][0].v).toBe("top");
    expect(rows[1]).toEqual([]);
    /* And a gap in the *columns* too — `C4` is the third column whether or not
       A and B were written. */
    expect(rows[3][2].v).toBe("away");
    expect(rows[3][0].v).toBe("");
  });

  test("the tab order is the workbook's, not the file names'", async () => {
    /* `sheet1.xml` is the order the sheets were created in, which stops being
       the order they are shown in the moment somebody drags a tab. */
    const zip = await workbook([
      {
        name: "xl/workbook.xml",
        body: `<workbook><sheets>
                 <sheet name="Summary" r:id="rId2"/>
                 <sheet name="Raw" r:id="rId1"/>
               </sheets></workbook>`,
      },
      {
        name: "xl/_rels/workbook.xml.rels",
        body: `<Relationships>
                 <Relationship Id="rId1" Target="worksheets/sheet1.xml"/>
                 <Relationship Id="rId2" Target="worksheets/sheet2.xml"/>
               </Relationships>`,
      },
      { name: "xl/worksheets/sheet1.xml", body: sheetXml(`<row r="1"><c r="A1" t="str"><v>raw</v></c></row>`) },
      { name: "xl/worksheets/sheet2.xml", body: sheetXml(`<row r="1"><c r="A1" t="str"><v>sum</v></c></row>`) },
    ]);
    const sheets = await readWorkbook(zip);
    expect(sheets.map((s) => s.name)).toEqual(["Summary", "Raw"]);
    expect(sheets[0].rows[0][0].v).toBe("sum");
  });

  test("a workbook with no readable index falls back to the parts", async () => {
    /* A sheet in an uncertain order beats no sheet. Numeric sort, or `sheet10`
       comes before `sheet2`. */
    const zip = await workbook([
      { name: "xl/worksheets/sheet2.xml", body: sheetXml(`<row r="1"><c r="A1" t="str"><v>two</v></c></row>`) },
      { name: "xl/worksheets/sheet1.xml", body: sheetXml(`<row r="1"><c r="A1" t="str"><v>one</v></c></row>`) },
    ]);
    const sheets = await readWorkbook(zip);
    expect(sheets.map((s) => s.rows[0][0].v)).toEqual(["one", "two"]);
  });

  test("a date is a date and not a five-digit number", async () => {
    const zip = await workbook([
      {
        name: "xl/styles.xml",
        body: `<styleSheet>
                 <numFmts><numFmt numFmtId="165" formatCode="dd/mm/yyyy"/></numFmts>
                 <cellXfs><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="165"/><xf numFmtId="4"/></cellXfs>
               </styleSheet>`,
      },
      {
        name: "xl/worksheets/sheet1.xml",
        body: sheetXml(
          `<row r="1">
             <c r="A1" s="0"><v>45000</v></c>
             <c r="B1" s="1"><v>45000</v></c>
             <c r="C1" s="2"><v>45000.5</v></c>
             <c r="D1" s="3"><v>45000</v></c>
           </row>`,
        ),
      },
    ]);
    const row = (await readWorkbook(zip))[0].rows[0];
    /* No format: the number it is. */
    expect(row[0].v).toBe("45000");
    /* Built-in 14 is `mm-dd-yy` and is not written into the file at all, which
       is why the ids have to be known here. */
    expect(row[1].v).toBe("2023-03-15");
    /* A fractional part is a time of day, and is only drawn when there is one. */
    expect(row[2].v).toBe("2023-03-15 12:00");
    /* `#,##0.00` is a number format with no date token in it. */
    expect(row[3].v).toBe("45000");
  });

  test("a sheet larger than the viewer holds says so", async () => {
    const rows = Array.from(
      { length: GRID_ROWS + 10 },
      (_, i) => `<row r="${i + 1}"><c r="A${i + 1}"><v>${i}</v></c></row>`,
    ).join("");
    const zip = await workbook([{ name: "xl/worksheets/sheet1.xml", body: sheetXml(rows) }]);
    const sheet = (await readWorkbook(zip))[0];
    expect(sheet.rows.length).toBe(GRID_ROWS);
    expect(sheet.capped).toBe(true);
  });

  test("a column past the last one Excel had is dropped and said", async () => {
    const zip = await workbook([
      {
        name: "xl/worksheets/sheet1.xml",
        body: sheetXml(`<row r="1"><c r="A1"><v>1</v></c><c r="ZZZ1"><v>2</v></c></row>`),
      },
    ]);
    const sheet = (await readWorkbook(zip))[0];
    expect(sheet.rows[0].length).toBeLessThanOrEqual(GRID_COLS);
    expect(sheet.capped).toBe(true);
  });

  test("a cell reference names its column", () => {
    expect(colOf("A1")).toBe(0);
    expect(colOf("B7")).toBe(1);
    expect(colOf("Z1")).toBe(25);
    expect(colOf("AA1")).toBe(26);
    expect(colOf("AB100")).toBe(27);
    expect(colOf("IV1")).toBe(255);
    expect(colOf("")).toBe(-1);
  });

  test("a number format is a date when its tokens are", () => {
    expect(isDateCode("dd/mm/yyyy")).toBe(true);
    expect(isDateCode("h:mm AM/PM")).toBe(true);
    expect(isDateCode("[$-409]d\\-mmm\\-yy;@")).toBe(true);
    expect(isDateCode("#,##0.00")).toBe(false);
    expect(isDateCode("0%")).toBe(false);
    expect(isDateCode("General")).toBe(false);
    /* A literal in quotes is not a token — this is a weight, not a date. */
    expect(isDateCode(`0" days"`)).toBe(false);
    /* Nor is a colour or a condition in brackets. `[Red]` has a `d` in it. */
    expect(isDateCode("[Red]-0.00")).toBe(false);
    /* An escaped character is a literal, `\\d` being the one that would read as
       a day. */
    expect(isDateCode("0\\d")).toBe(false);
  });

  test("the serial epoch is the one Lotus believed in", () => {
    /* 1899-12-30, because Excel has been bug-compatible with 1-2-3's belief that
       1900 was a leap year since 1985. */
    expect(serialDate(45000)).toBe("2023-03-15");
    expect(serialDate(61)).toBe("1900-03-01");
    /* Below 61 the two calendars disagree, so the number is the honest answer. */
    expect(serialDate(59)).toBeNull();
    expect(serialDate(0)).toBeNull();
    expect(serialDate(-1)).toBeNull();
    expect(serialDate(NaN)).toBeNull();
    expect(serialDate(1e9)).toBeNull();
  });
});

/* ── csv ──────────────────────────────────────────────────────────────────── */

describe("a table", () => {
  test("quoting, doubled quotes and embedded newlines", () => {
    const rows = splitRows(`a,b\n"has, comma","says ""hi""","line\nbreak"`, ",");
    expect(rows[0]).toEqual(["a", "b"]);
    expect(rows[1]).toEqual([`has, comma`, `says "hi"`, "line\nbreak"]);
  });

  test("every row terminator anybody has written", () => {
    expect(splitRows("a\r\nb\rc\nd", ",").flat()).toEqual(["a", "b", "c", "d"]);
  });

  test("a trailing newline is not an empty last row", () => {
    /* The same phantom `viewLines` drops, and for the same reason: every text
       file ends with one. */
    expect(splitRows("a,b\nc,d\n", ",").length).toBe(2);
  });

  test("Excel's byte-order mark does not become part of the first heading", () => {
    const rows = splitRows("﻿name,qty\nbolt,4", ",");
    expect(rows[0][0]).toBe("name");
  });

  test("a quote that is never closed runs to the end rather than throwing", () => {
    expect(() => splitRows(`a,"unclosed`, ",")).not.toThrow();
    expect(splitRows(`a,"unclosed`, ",")[0]).toEqual(["a", "unclosed"]);
  });

  test("a semicolon file is not one enormous cell", () => {
    /* Half the CSVs in a European company: Excel writes `;` for every locale
       whose decimal separator is a comma. */
    expect(sniffDelimiter("name;qty;price\nbolt;4;1,50\nnut;8;0,30")).toBe(";");
    expect(sniffDelimiter("name,qty\nbolt,4\nnut,8")).toBe(",");
    expect(sniffDelimiter("name\tqty\nbolt\t4")).toBe("\t");
  });

  test("a delimiter inside a quoted field does not win", () => {
    /* Scored on consistency across rows rather than on the count in the first
       one, which is the guard: the `;` here appears once, inside a field. */
    expect(sniffDelimiter(`name,note\nbolt,"a; b"\nnut,"c; d"`)).toBe(",");
  });

  test("a single-column file keeps its default rather than inventing a split", () => {
    expect(sniffDelimiter("alpha\nbeta\ngamma")).toBe(",");
    expect(readTable("one.csv", "alpha\nbeta").rows.length).toBe(2);
  });

  test("what counts as a number is the shape and not the coercion", () => {
    const grid = readTable("parts.csv", "code,qty\n007,4\n,\n-2.5,x");
    /* `Number("007")` is 7, so a part code with leading zeros would be
       right-aligned as a quantity if this were a coercion. */
    expect(grid.rows[1][0]).toEqual({ v: "007", num: false });
    expect(grid.rows[1][1].num).toBe(true);
    /* A blank is not a number. */
    expect(grid.rows[2][0]).toEqual({ v: "", num: false });
    expect(grid.rows[3][0].num).toBe(true);
    expect(grid.rows[3][1].num).toBe(false);
  });

  test("the grid says which delimiter it read", () => {
    /* Drawn on the sheet tab, because a CSV read with the wrong delimiter is the
       one failure that looks like the file being wrong. */
    expect(readTable("q3.csv", "a;b\n1;2").name).toBe("q3.csv · ;");
    expect(readTable("q3.tsv", "a\tb\n1\t2").name).toBe("q3.tsv · tab");
  });
});

/* ── word ─────────────────────────────────────────────────────────────────── */

describe("a word document", () => {
  async function word(members: Member[]) {
    return Zip.open(
      await zipOf([
        { name: "[Content_Types].xml", body: CONTENT_TYPES("wordprocessingml.document.main") },
        ...members,
      ]),
    );
  }
  const doc = (body: string) => ({
    name: "word/document.xml",
    body: `<w:document><w:body>${body}</w:body></w:document>`,
  });

  test("headings and paragraphs become the block model's own", async () => {
    const zip = await word([
      doc(`<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Title</w:t></w:r></w:p>
           <w:p><w:r><w:t>Some prose.</w:t></w:r></w:p>
           <w:p/>
           <w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Detail</w:t></w:r></w:p>`),
    ]);
    const blocks = await readWord(zip);
    /* An empty paragraph is Word's blank line and there are a great many of
       them; drawn, they are a document with holes in it. */
    expect(blocks.length).toBe(3);
    expect(blocks[0]).toMatchObject({ t: "h", level: 1 });
    expect(blocks[1].t).toBe("p");
    expect(blocks[2]).toMatchObject({ t: "h", level: 2 });
  });

  test("bold and italic nest rather than being lost", async () => {
    /* Built as `Inline` nodes rather than as markdown text, which is the reason
       there is no escaping anywhere in this file: a paragraph with a literal
       asterisk in it stays a paragraph with an asterisk in it. */
    const zip = await word([
      doc(`<w:p>
             <w:r><w:t>plain </w:t></w:r>
             <w:r><w:rPr><w:b/></w:rPr><w:t>bold</w:t></w:r>
             <w:r><w:rPr><w:b/><w:i/></w:rPr><w:t>both</w:t></w:r>
             <w:r><w:t> 2 * 3</w:t></w:r>
           </w:p>`),
    ]);
    const [p] = await readWord(zip);
    expect(p.t).toBe("p");
    const kids = (p as Extract<Block, { t: "p" }>).kids;
    expect(kids[0]).toEqual({ t: "text", v: "plain " });
    expect(kids[1]).toEqual({ t: "strong", kids: [{ t: "text", v: "bold" }] });
    expect(kids[2]).toEqual({
      t: "strong",
      kids: [{ t: "em", kids: [{ t: "text", v: "both" }] }],
    });
    expect(kids[3]).toEqual({ t: "text", v: " 2 * 3" });
  });

  test("a hyperlink carries the target its relationship names", async () => {
    const zip = await word([
      doc(`<w:p><w:hyperlink r:id="rId7"><w:r><w:t>the wiki</w:t></w:r></w:hyperlink></w:p>`),
      {
        name: "word/_rels/document.xml.rels",
        body: `<Relationships><Relationship Id="rId7" Target="https://example.com/wiki"/></Relationships>`,
      },
    ]);
    const [p] = await readWord(zip);
    expect((p as Extract<Block, { t: "p" }>).kids[0]).toMatchObject({
      t: "link",
      href: "https://example.com/wiki",
    });
  });

  test("a run of list paragraphs becomes one list", async () => {
    /* There is no list element in a Word file — a list is a *run* of paragraphs
       each carrying a `numPr`, and the tree has to be rebuilt from that. */
    const zip = await word([
      doc(`<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="3"/></w:numPr></w:pPr><w:r><w:t>one</w:t></w:r></w:p>
           <w:p><w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="3"/></w:numPr></w:pPr><w:r><w:t>nested</w:t></w:r></w:p>
           <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="3"/></w:numPr></w:pPr><w:r><w:t>two</w:t></w:r></w:p>
           <w:p><w:r><w:t>after</w:t></w:r></w:p>`),
      {
        name: "word/numbering.xml",
        body: `<numbering>
                 <abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></abstractNum>
                 <num w:numId="3"><w:abstractNumId w:val="0"/></num>
               </numbering>`,
      },
    ]);
    const blocks = await readWord(zip);
    expect(blocks.length).toBe(2);
    const list = blocks[0] as Extract<Block, { t: "list" }>;
    expect(list.t).toBe("list");
    /* `decimal` at level zero means a numbered list, which is two hops through
       `numbering.xml` to find out. */
    expect(list.ordered).toBe(true);
    expect(list.items.length).toBe(2);
    /* The nested one is inside its parent item rather than a sibling. */
    expect(list.items[0].some((b) => b.t === "list")).toBe(true);
    expect(blocks[1].t).toBe("p");
  });

  test("a bullet list is not numbered", async () => {
    const zip = await word([
      doc(`<w:p><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>a</w:t></w:r></w:p>`),
      {
        name: "word/numbering.xml",
        body: `<numbering>
                 <abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl></abstractNum>
                 <num w:numId="1"><w:abstractNumId w:val="0"/></num>
               </numbering>`,
      },
    ]);
    const list = (await readWord(zip))[0] as Extract<Block, { t: "list" }>;
    expect(list.ordered).toBe(false);
  });

  test("numId zero is a paragraph that used to be in a list", async () => {
    const zip = await word([
      doc(`<w:p><w:pPr><w:numPr><w:numId w:val="0"/></w:numPr></w:pPr><w:r><w:t>plain</w:t></w:r></w:p>`),
    ]);
    expect((await readWord(zip))[0].t).toBe("p");
  });

  test("a table's first row is its head", async () => {
    const zip = await word([
      doc(`<w:tbl>
             <w:tr><w:tc><w:p><w:r><w:t>Region</w:t></w:r></w:p></w:tc>
                   <w:tc><w:p><w:r><w:t>Sales</w:t></w:r></w:p></w:tc></w:tr>
             <w:tr><w:tc><w:p><w:r><w:t>EMEA</w:t></w:r></w:p></w:tc>
                   <w:tc><w:p><w:r><w:t>12</w:t></w:r></w:p></w:tc></w:tr>
           </w:tbl>`),
    ]);
    const t = (await readWord(zip))[0] as Extract<Block, { t: "table" }>;
    expect(t.t).toBe("table");
    expect(t.head.length).toBe(2);
    expect(t.rows.length).toBe(1);
  });

  test("a merged cell keeps the columns lined up", async () => {
    /* `gridSpan` is read only far enough to pad, because a row that is short by
       one draws every cell in it under the wrong heading. */
    const zip = await word([
      doc(`<w:tbl>
             <w:tr><w:tc><w:p><w:r><w:t>a</w:t></w:r></w:p></w:tc>
                   <w:tc><w:p><w:r><w:t>b</w:t></w:r></w:p></w:tc>
                   <w:tc><w:p><w:r><w:t>c</w:t></w:r></w:p></w:tc></w:tr>
             <w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>wide</w:t></w:r></w:p></w:tc>
                   <w:tc><w:p><w:r><w:t>z</w:t></w:r></w:p></w:tc></w:tr>
           </w:tbl>`),
    ]);
    const t = (await readWord(zip))[0] as Extract<Block, { t: "table" }>;
    expect(t.rows[0].length).toBe(3);
  });

  test("a tracked deletion is not in the document", async () => {
    /* The text is in the file and is *not* in the document, and drawing it would
       put prose nobody wrote into the middle of a paragraph. */
    const zip = await word([
      doc(`<w:p><w:r><w:t>kept </w:t></w:r>
             <w:del><w:r><w:delText>struck</w:delText></w:r></w:del>
             <w:ins><w:r><w:t>added</w:t></w:r></w:ins></w:p>`),
    ]);
    const p = (await readWord(zip))[0] as Extract<Block, { t: "p" }>;
    const text = p.kids.map((k) => ("v" in k ? k.v : "")).join("");
    expect(text).toBe("kept added");
  });

  test("a heading style is matched past its language", () => {
    expect(headingLevel("Heading1")).toBe(1);
    expect(headingLevel("Heading6")).toBe(6);
    expect(headingLevel("Title")).toBe(1);
    expect(headingLevel("Subtitle")).toBe(2);
    /* The German style id, with the umlaut already eaten by Word's own rules. */
    expect(headingLevel("berschrift3")).toBe(3);
    expect(headingLevel("Heading7")).toBe(0);
    expect(headingLevel("BodyText")).toBe(0);
    expect(headingLevel("")).toBe(0);
  });

  test("a document with no body is empty rather than an error", async () => {
    const zip = await word([{ name: "word/document.xml", body: `<w:document/>` }]);
    expect(await readWord(zip)).toEqual([]);
  });
});

/* ── powerpoint ───────────────────────────────────────────────────────────── */

describe("a deck", () => {
  const slide = (body: string) => `<p:sld><p:cSld><p:spTree>${body}</p:spTree></p:cSld></p:sld>`;
  const shape = (type: string, ...lines: string[]) =>
    `<p:sp><p:nvSpPr><p:nvPr>${type ? `<p:ph type="${type}"/>` : ""}</p:nvPr></p:nvSpPr>
       <p:txBody>${lines.map((l) => `<a:p><a:r><a:t>${l}</a:t></a:r></a:p>`).join("")}</p:txBody>
     </p:sp>`;

  async function deck(members: Member[]) {
    return Zip.open(
      await zipOf([
        {
          name: "[Content_Types].xml",
          body: CONTENT_TYPES("presentationml.presentation.main"),
        },
        ...members,
      ]),
    );
  }

  test("a slide's title is its heading and the rest is its outline", async () => {
    const zip = await deck([
      {
        name: "ppt/presentation.xml",
        /* Both attributes, as PowerPoint really writes it: `id` is the slide's
           own number and `r:id` is the relationship. Reading the local name
           `id` answers 256, the map lookup misses, and every deck falls through
           to guessing from filenames — which is what the first fixture here hid
           by carrying only `r:id`. See `relId`. */
        body: `<p:presentation><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst></p:presentation>`,
      },
      {
        name: "ppt/_rels/presentation.xml.rels",
        body: `<Relationships><Relationship Id="rId2" Target="slides/slide1.xml"/></Relationships>`,
      },
      {
        name: "ppt/slides/slide1.xml",
        body: slide(shape("title", "Q3 review") + shape("", "revenue up", "costs flat")),
      },
    ]);
    const blocks = await readDeck(zip);
    expect(blocks[0]).toMatchObject({ t: "h", level: 2 });
    expect(blocks[1]).toMatchObject({ t: "list", ordered: false });
    expect((blocks[1] as Extract<Block, { t: "list" }>).items.length).toBe(2);
  });

  test("a slide with no title is numbered rather than blank", async () => {
    const zip = await deck([
      { name: "ppt/slides/slide1.xml", body: slide(shape("", "just a picture caption")) },
    ]);
    const h = (await readDeck(zip))[0] as Extract<Block, { t: "h" }>;
    expect(h.kids[0]).toEqual({ t: "text", v: "slide 1" });
  });

  test("slide order comes off the presentation, and the fallback sorts numerically", async () => {
    const zip = await deck([
      { name: "ppt/slides/slide10.xml", body: slide(shape("title", "tenth")) },
      { name: "ppt/slides/slide2.xml", body: slide(shape("title", "second")) },
    ]);
    const titles = (await readDeck(zip))
      .filter((b): b is Extract<Block, { t: "h" }> => b.t === "h")
      .map((h) => ("v" in h.kids[0] ? h.kids[0].v : ""));
    /* `slide10` sorts before `slide2` as a string, which is the whole reason
       this comparator exists. */
    expect(titles).toEqual(["second", "tenth"]);
  });

  test("text inside a group is still on the slide", async () => {
    const zip = await deck([
      {
        name: "ppt/slides/slide1.xml",
        body: slide(`<p:grpSp>${shape("", "inside a group")}</p:grpSp>`),
      },
    ]);
    const list = (await readDeck(zip))[1] as Extract<Block, { t: "list" }>;
    expect(list.items.length).toBe(1);
  });
});

/* ── the one entry point ──────────────────────────────────────────────────── */

describe("readDocument", () => {
  test("the package's own content type decides the family", async () => {
    /* `[Content_Types].xml` first, because it is the one part every OPC package
       is required to have and it is the format's own answer. Here the extension
       says `.xlsx` and the package says Word — and the package wins. */
    const bytes = await zipOf([
      { name: "[Content_Types].xml", body: CONTENT_TYPES("wordprocessingml.document.main") },
      {
        name: "word/document.xml",
        body: `<w:document><w:body><w:p><w:r><w:t>hello</w:t></w:r></w:p></w:body></w:document>`,
      },
    ]);
    const doc = await readDocument(bytes, "xlsx");
    expect(doc.kind).toBe("prose");
  });

  test("the directory prefixes are the fallback", async () => {
    const zip = Zip.open(await zipOf([{ name: "xl/workbook.xml", body: "<workbook/>" }]));
    expect(familyOf(zip, null)).toBe("sheet");
    const word = Zip.open(await zipOf([{ name: "word/document.xml", body: "<w:document/>" }]));
    expect(familyOf(word, null)).toBe("word");
    const deck = Zip.open(await zipOf([{ name: "ppt/presentation.xml", body: "<p/>" }]));
    expect(familyOf(deck, null)).toBe("deck");
    const neither = Zip.open(await zipOf([{ name: "a.txt", body: "x" }]));
    expect(familyOf(neither, null)).toBeNull();
  });

  test("a pdf is handed over unparsed", async () => {
    const bytes = TEXT.encode("%PDF-1.7\nnot really a pdf");
    const doc = await readDocument(bytes, "pdf");
    expect(doc.kind).toBe("pdf");
    /* The same bytes, not a copy — the blob is made from them in `Folio`. */
    if (doc.kind === "pdf") expect(doc.bytes).toBe(bytes);
  });

  test("a legacy file is named rather than opened", async () => {
    const ole = new Uint8Array(512);
    ole.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    for (const [ext, said] of [
      ["doc", /Word/],
      ["xls", /Excel/],
      ["ppt", /PowerPoint/],
      ["", /Office/],
    ] as const) {
      const doc = await readDocument(ole, ext);
      expect(doc.kind).toBe("legacy");
      if (doc.kind === "legacy") expect(doc.what).toMatch(said);
    }
  });
});
