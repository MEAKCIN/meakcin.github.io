# meakcin.github.io

Personal site of Mehmet Emin Akçin, live at **https://meakcin.github.io**.

A single static page: no build step and no dependencies. GitHub Pages serves it straight from `main`.

- `index.html` holds all the content: experience, projects, skills, education and contact.
- `assets/site.css` holds the styles, with light and dark themes.
- `assets/search.js` powers the "Search my work" box. It indexes every element marked `data-doc` and ranks matches with BM25, prefix matching and typo correction, all in the browser.

## Edit

To add a project or role, copy an existing `<li>` in `index.html` and keep its `data-doc`, `data-kind` and `data-title` attributes. The search picks it up automatically.

## Run locally

```bash
python3 -m http.server 4173
```

Then open http://localhost:4173.
