const Printer = require("./");
const fs = require("fs");

(async () => {
  let printer = new Printer();
  // let page = await printer.render("test/samples/aurorae/index.html");
  let pdf = await printer.pdf(
    "https://s3.amazonaws.com/pagedmedia/samples/text.html"
  );
  // const html = await readFile("test/samples/aurorae/index.html", "utf-8");
  // let pdf = await printer.pdf({ html });
  // let html = await printer.html("test/samples/aurorae/index.html");
  fs.writeFileSync(`output/out-${Date.now()}.pdf`, pdf);
  return process.exit(0);
})();
