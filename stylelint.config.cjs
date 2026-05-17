module.exports = {
  plugins: ["stylelint-order"],
  overrides: [
    {
      files: ["**/*.vue"],
      customSyntax: "postcss-html",
    },
    {
      files: ["**/*.{css,scss}"],
      customSyntax: "postcss-scss",
    },
  ],
  rules: {
    "order/properties-order": [
      // 1. Content（::before / ::after 先頭）
      {
        groupName: "Content",
        properties: ["content", "list-style", "list-style-type", "list-style-position", "list-style-image", "counter-reset", "counter-increment", "quotes"],
      },
      // 2. Positioning
      {
        groupName: "Positioning",
        properties: ["position", "z-index", "top", "right", "bottom", "left", "inset"],
      },
      // 3. Box Model
      {
        groupName: "Box Model",
        properties: ["margin", "margin-top", "margin-right", "margin-bottom", "margin-left", "margin-inline", "margin-inline-start", "margin-inline-end", "margin-block", "margin-block-start", "margin-block-end", "padding", "padding-top", "padding-right", "padding-bottom", "padding-left", "padding-inline", "padding-inline-start", "padding-inline-end", "padding-block", "padding-block-start", "padding-block-end", "width", "min-width", "max-width", "height", "min-height", "max-height"],
      },
      // 4. Display / Flow / Flex / Grid
      {
        groupName: "Display",
        properties: ["display", "flex", "flex-direction", "flex-wrap", "flex-flow", "justify-content", "justify-items", "justify-self", "align-items", "align-content", "align-self", "gap", "row-gap", "column-gap", "grid", "grid-template", "grid-template-columns", "grid-template-rows", "grid-column", "grid-row", "grid-area", "visibility", "float", "clear", "overflow", "overflow-x", "overflow-y"],
      },
      // 5. Typography
      {
        groupName: "Typography",
        properties: ["font", "font-family", "font-size", "font-weight", "font-style", "font-variant", "line-height", "letter-spacing", "word-spacing", "text-align", "text-decoration", "text-transform", "text-indent", "text-overflow", "white-space", "word-break", "word-wrap"],
      },
      // 6. Visual
      {
        groupName: "Visual",
        properties: ["color", "background", "background-color", "background-image", "background-position", "background-size", "background-repeat", "border", "border-top", "border-right", "border-bottom", "border-left", "border-width", "border-style", "border-color", "border-radius", "box-shadow", "outline"],
      },
      // 7. Decoration
      {
        groupName: "Decoration",
        properties: ["opacity", "transform", "transform-origin", "transition", "transition-property", "transition-duration", "animation", "animation-name", "animation-duration", "cursor", "pointer-events", "user-select", "will-change", "appearance"],
      },
    ],
  },
};