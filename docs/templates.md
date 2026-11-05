# Notebooks in note templates

Two ways to get a notebook into a new note when you use Obsidian's core **Templates** plugin or **Templater**. Both need a notebook template if you want more than a blank notebook: make one with *Save as notebook template* in a notebook's menu (see the notebook templates in the settings).

| | Core Templates | Templater |
|---|---|---|
| The `notebook-new` button | yes | yes |
| A notebook made the moment the note is created | no | yes (user script or inline command) |

## 1. The `notebook-new` button (works with both)

Put this in your template file:

````md
# {{title}}

```notebook-new
name="{{title}} sketches"
template="Lecture"
```
````

With **Templater** write the title as `<% tp.file.title %>`:

````md
```notebook-new
name="<% tp.file.title %> sketches"
template="Lecture"
```
````

Both plugins expand the placeholder in the name and leave the rest of the block alone. In the new note the block shows a card with a **Create notebook** button. Nothing is created until you press it. Pressing it makes the notebook and replaces only that block with an embed, `![[<name>.notebook]]`. The note around it is not touched. If the block was edited or removed in the meantime, or the same block appears twice and cannot be told apart, nothing is created and you get a notice.

Keys (one per line, `key="value"`; `key: value` also works):

| Key | Meaning |
|---|---|
| `name` | Required. The file name of the notebook. A number is added if it is taken. |
| `template` | Optional. A notebook template, by name. Without it you get a plain notebook with your default paper. |
| `folder` | Optional. Where to put it. Default: your notebooks folder. |
| `content` | Optional, with `template`. `false` keeps only the template's pages; the default `true` keeps its ink and text too. |
| `open` | Optional. `true` also opens the notebook in a tab. |

An unknown key, a `name` that still contains `{{...}}` or `<% ... %>` (the template was not run), or a missing name shows a short explanation in the card instead of the button.

## 2. Templater: create the notebook when the note is created

A Templater user script gives you the notebook and its embed at once. Save this as `Scripts/new-notebook.js` and set `Scripts` as the *Script files folder* in Templater's settings:

```js
module.exports = async (tp, name, template) => {
  const api = tp.app.plugins.plugins["notebook"]?.api;
  if (!api) return "(Notebook plugin is not enabled)";
  try {
    const nb = await api.newNotebook({ name, template, folder: "Notebooks/Lectures" });
    return nb.embed; // ![[Lecture 12 sketches.notebook]]
  } catch (e) {
    return `(Notebook: ${e.message})`;
  }
};
```

In the note template:

```md
# <% tp.file.title %>

<% tp.user["new-notebook"](tp, tp.file.title + " sketches", "Lecture") %>
```

(Templater runs user scripts with `tp.user.<script name>`; the first argument is `tp` so the script can reach the app.) Return `nb.link` instead of `nb.embed` for a plain `[[link]]`.

Without a script, an inline command works too:

```md
<%* const api = tp.app.plugins.plugins["notebook"].api;
const nb = await api.newNotebook({ name: tp.file.title + " sketches", template: "Lecture" });
tR += nb.embed; %>
```

This one creates the notebook as soon as Templater runs the template, so use the button (section 1) if you sometimes insert the template and then do not want a notebook.

## 3. Core Templates

Core Templates only expands `{{title}}`, `{{date}}` and `{{time}}`, and cannot run code. Use the button from section 1:

````md
---
tags: lecture
---
# {{title}}

```notebook-new
name="{{title}} notes"
template="Lecture"
```
````

## Notes

- Everything here goes through the [public API](api.md) (`api.newNotebook`, since API 1.2). The document format is unchanged.
- Notebook templates live in the notebook templates folder (settings). The name in `template=` is the file name without `.notebook`, any case.
- Creating from the button needs the Notebook plugin to be enabled; it works on Android and desktop.
