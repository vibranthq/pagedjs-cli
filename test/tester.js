const Printer = require("../");
const fs = require("fs");

(async () => {
  const printer = new Printer();
  // const page = await printer.render("test/samples/aurorae/index.html");
  const pdf = await printer.pdf(
    "https://s3.amazonaws.com/pagedmedia/samples/text.html"
  );
  // const html = await readFile("test/samples/aurorae/index.html", "utf-8");
  // const pdf = await printer.pdf({ html });
  // const html = await printer.html("test/samples/aurorae/index.html");
  fs.writeFileSync(`output/out-${Date.now()}.pdf`, pdf);
  return process.exit(0);
})();
