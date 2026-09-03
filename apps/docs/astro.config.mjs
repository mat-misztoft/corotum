import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";
import starlight from "@astrojs/starlight";

export default defineConfig({
  site: "https://docs.corotum.com",
  integrations: [
    sitemap(),
    starlight({
      title: "Corotum Docs",
      description: "Documentation for Corotum skill management, Git Sync, and Corotum Cloud.",
      favicon: "/favicon.svg",
      customCss: ["./src/styles/corotum.css"],
      social: [
        {
          icon: "github",
          label: "Corotum on GitHub",
          href: "https://github.com/mat_misztoft/corotum",
        },
      ],
      head: [
        {
          tag: "meta",
          attrs: {
            property: "og:image",
            content: "https://docs.corotum.com/og-image.svg",
          },
        },
        {
          tag: "meta",
          attrs: { name: "twitter:card", content: "summary_large_image" },
        },
      ],
      sidebar: [
        { label: "Getting Started", items: [{ label: "Overview", link: "/" }, { label: "Install", slug: "getting-started/install" }] },
        { label: "CLI", items: [{ label: "Commands", slug: "cli/commands" }] },
        { label: "Concepts", items: [{ label: "Skills", slug: "concepts/skills" }, { label: "Git Sync", slug: "concepts/git-sync" }] },
        { label: "Cloud", items: [{ label: "Hosted Corotum Cloud", slug: "cloud/hosted" }, { label: "Self-hosting", slug: "cloud/self-hosting" }] },
        { label: "WebMCP", items: [{ label: "Dashboard and WebMCP", slug: "webmcp/dashboard-and-webmcp" }] },
        { label: "Guides", items: [{ label: "Migration", slug: "guides/migration" }] },
        { label: "Reference", items: [{ label: "Product reference", slug: "reference/product" }] },
        { label: "Troubleshooting", items: [{ label: "Troubleshooting", slug: "troubleshooting" }] },
      ],
    }),
  ],
});
