/** Spreadsheet apps run cells that start with these characters as formulas. */
const FORMULA_START = /^[=+\-@\t\r]/;

/** Exports text as plain text: a leading apostrophe stops spreadsheet formula evaluation. */
export const plainTextCell = (value: string) => FORMULA_START.test(value) ? `'${value}` : value;
