export function nonNegativeNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function nonNegativeInteger(value: unknown) {
  const number = nonNegativeNumber(value);

  return number !== undefined && Number.isSafeInteger(number) ? number : undefined;
}
