const EventEmitter = require("events");
const puppeteer = require("puppeteer");

const path = require("path");

const dir = process.cwd();

// Find top most pagedjs
const pagedjsLocation = require.resolve("pagedjs/dist/paged.polyfill.js");
const paths = pagedjsLocation.split("node_modules");
const scriptPath = paths[0] + "node_modules" + paths[paths.length - 1];

const PostProcessor = require("./postprocessor");

class Printer extends EventEmitter {
  constructor(options = {}) {
    super();

    this.headless = options.headless !== false;
    this.allowLocal = options.allowLocal;
    this.allowRemote = options.allowRemote;
    this.additionalScripts = options.additionalScripts || [];
    this.allowedPaths = options.allowedPaths || [];
    this.allowedDomains = options.allowedDomains || [];
    this.ignoreHTTPSErrors = options.ignoreHTTPSErrors || true;
    this.browserWSEndpoint = options.browserEndpoint;

    this.pages = [];
  }

  async setup() {
    const puppeteerOptions = {
      headless: this.headless,
      args: ["--disable-dev-shm-usage"],
      ignoreHTTPSErrors: this.ignoreHTTPSErrors,
    };

    if (this.allowLocal) {
      puppeteerOptions.args.push("--allow-file-access-from-files");
    }

    if (this.browserWSEndpoint) {
      puppeteerOptions.browserWSEndpoint = this.browserWSEndpoint;
    }

    return (this.browser = await puppeteer.launch(puppeteerOptions));
  }

  async render(input) {
    let resolver;
    const rendered = new Promise(function (resolve) {
      resolver = resolve;
    });

    if (!this.browser) {
      await this.setup();
    }

    const page = await this.browser.newPage();

    let url, relativePath, html;
    if (typeof input === "string") {
      try {
        new URL(input); // validate URL
        url = input;
      } catch (error) {
        relativePath = path.resolve(dir, input);
        url = "file://" + relativePath;
      }
    } else {
      url = input.url;
      html = input.html;
    }

    await page.setRequestInterception(true);

    page.on("request", (request) => {
      const uri = new URL(request.url());
      const { host, protocol, pathname } = uri;
      const local = protocol === "file:";

      if (local && !this.withinAllowedPath(pathname)) {
        request.abort();
        return;
      }

      if (local && !this.allowLocal) {
        request.abort();
        return;
      }

      if (host && !this.isAllowedDomain(host)) {
        request.abort();
        return;
      }

      if (host && !this.allowRemote) {
        request.abort();
        return;
      }

      request.continue();
    });

    if (html) {
      await page.setContent(html).catch((e) => {
        console.error(e);
      });

      if (url) {
        await page.evaluate((url) => {
          let base = document.querySelector("base");
          if (!base) {
            base = document.createElement("base");
            document.querySelector("head").appendChild(base);
          }
          base.setAttribute("href", url);
        }, url);
      }
    } else {
      await page.goto(url).catch((e) => {
        console.error(e);
      });
    }

    await page.evaluate(() => {
      window.PagedConfig = window.PagedConfig || {};
      window.PagedConfig.auto = false;
    });

    await page.addScriptTag({
      path: scriptPath,
    });

    for (const script of this.additionalScripts) {
      await page.addScriptTag({
        path: script,
      });
    }

    await page.exposeFunction("onSize", (size) => {
      this.emit("size", size);
    });

    await page.exposeFunction("onPage", (page) => {
      this.pages.push(page);

      this.emit("page", page);
    });

    await page.exposeFunction(
      "onRendered",
      (msg, width, height, orientation) => {
        this.emit("rendered", msg, width, height, orientation);
        resolver({ msg, width, height, orientation });
      }
    );

    await page.evaluate(() => {
      window.PagedPolyfill.on("page", (page) => {
        const {
          id,
          width,
          height,
          startToken,
          endToken,
          breakAfter,
          breakBefore,
          position,
        } = page;

        const mediaBox = page.element.getBoundingClientRect();
        const cropBox = page.pagebox.getBoundingClientRect();

        function getPointsValue(value) {
          return Math.round(CSS.px(value).to("pt").value * 100) / 100;
        }

        const boxes = {
          media: {
            width: getPointsValue(mediaBox.width),
            height: getPointsValue(mediaBox.height),
            x: 0,
            y: 0,
          },
          crop: {
            width: getPointsValue(cropBox.width),
            height: getPointsValue(cropBox.height),
            x: getPointsValue(cropBox.x) - getPointsValue(mediaBox.x),
            y: getPointsValue(cropBox.y) - getPointsValue(mediaBox.y),
          },
        };

        window.onPage({
          id,
          width,
          height,
          startToken,
          endToken,
          breakAfter,
          breakBefore,
          position,
          boxes,
        });
      });

      window.PagedPolyfill.on("size", (size) => {
        window.onSize(size);
      });

      window.PagedPolyfill.on("rendered", (flow) => {
        const msg =
          "Rendering " +
          flow.total +
          " pages took " +
          flow.performance +
          " milliseconds.";
        window.onRendered(msg, flow.width, flow.height, flow.orientation);
      });

      window.PagedPolyfill.preview();
    });

    await rendered;

    await page.waitForSelector(".pagedjs_pages");

    return page;
  }

  async _parseOutline(page, tags) {
    return await page.evaluate((tags) => {
      const tagsToProcess = [];
      for (const node of document.querySelectorAll(tags.join(","))) {
        tagsToProcess.push(node);
      }
      tagsToProcess.reverse();

      const root = { children: [], depth: -1 };
      let currentOutlineNode = root;

      while (tagsToProcess.length > 0) {
        const tag = tagsToProcess.pop();
        const orderDepth = tags.indexOf(tag.tagName.toLowerCase());

        if (orderDepth < currentOutlineNode.depth) {
          currentOutlineNode = currentOutlineNode.parent;
          tagsToProcess.push(tag);
        } else {
          const newNode = {
            title: tag.innerText,
            id: tag.id,
            children: [],
            depth: orderDepth,
          };
          if (orderDepth == currentOutlineNode.depth) {
            newNode.parent = currentOutlineNode.parent;
            currentOutlineNode.parent.children.push(newNode);
            currentOutlineNode = newNode;
          } else if (orderDepth > currentOutlineNode.depth) {
            newNode.parent = currentOutlineNode;
            currentOutlineNode.children.push(newNode);
            currentOutlineNode = newNode;
          }
        }
      }

      const stripParentProperty = (node) => {
        node.parent = undefined;
        for (const child of node.children) {
          stripParentProperty(child);
        }
      };
      stripParentProperty(root);
      return root.children;
    }, tags);
  }

  async pdf(input, options = {}) {
    const page = await this.render(input);

    // Get meta tags
    const meta = await page.evaluate(() => {
      const meta = {};
      const title = document.querySelector("title");
      if (title) {
        meta.title = title.textContent.trim();
      }
      const metaTags = document.querySelectorAll("meta");
      [...metaTags].forEach((tag) => {
        if (tag.name) {
          meta[tag.name] = tag.content;
        }
      });
      return meta;
    });

    const outline =
      options.outlineTags && options.outlineTags.length > 0
        ? await this._parseOutline(page, options.outlineTags)
        : null;

    const settings = {
      printBackground: true,
      displayHeaderFooter: false,
      preferCSSPageSize: options.width ? false : true,
      width: options.width,
      height: options.height,
      orientation: options.orientation,
      margin: {
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
      },
    };

    const pdf = await page.pdf(settings).catch((e) => {
      console.error(e);
    });

    await page.close();

    this.emit("postprocessing");

    const post = new PostProcessor(pdf);
    post.metadata(meta);
    post.boxes(this.pages);
    if (outline) {
      post.addOutline(outline);
    }

    return post.save();
  }

  async html(input, stayOpen) {
    const page = await this.render(input);

    const content = await page.content().catch((e) => {
      console.error(e);
    });

    await page.close();
    return content;
  }

  async preview(input) {
    const page = await this.render(input);
    return page;
  }

  async close() {
    return this.browser.close();
  }

  withinAllowedPath(pathname) {
    if (!this.allowedPaths || this.allowedPaths.length === 0) {
      return true;
    }

    for (let parent of this.allowedPaths) {
      const relative = path.relative(parent, pathname);
      if (
        relative &&
        !relative.startsWith("..") &&
        !path.isAbsolute(relative)
      ) {
        return true;
      }
    }

    return false;
  }

  isAllowedDomain(domain) {
    if (!this.allowedDomains || this.allowedDomains.length === 0) {
      return true;
    }
    return this.allowedDomains.includes(domain);
  }
}

module.exports = Printer;
