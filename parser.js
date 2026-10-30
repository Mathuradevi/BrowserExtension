const AmazonProductParser = (() => {
  function parse(payload) {
    const listing = payload?.reconciledListing?.detailPageListingResponse || {};
    const resolvedMpn = firstAttributeValue(listing, [
      ["manufacturer_part_number#1.value", "manufacturer_part_number"],
      ["manufacturer_part_number#1", "manufacturer_part_number"],
      ["manufacturer_part_number", "manufacturer_part_number"],
      ["part_number#1.value", "part_number"],
      ["part_number#1", "part_number"],
      ["part_number", "part_number"],
      ["model_number#1.value", "model_number"],
      ["model_number#1", "model_number"],
      ["model_number", "model_number"]
    ]);

    return {
      asin: stringOrEmpty(payload?.asin),
      title: nestedValue(listing["item_name#1.value"]),
      brand: nestedValue(listing["brand#1.value"]),
      mpn: resolvedMpn.value,
      mpnSource: resolvedMpn.source,
      imageUrl: stringOrEmpty(payload?.imageUrl) || nestedValue(listing.detail_page_primary_image_url)
    };
  }

  function firstAttributeValue(listing, candidates) {
    for (const [key, source] of candidates) {
      const value = attributeValue(listing[key]).trim();
      if (value) {
        return { value, source };
      }
    }
    return { value: "", source: "" };
  }

  function attributeValue(node) {
    if (typeof node === "string") {
      return node;
    }
    return stringOrEmpty(node?.value);
  }

  function nestedValue(node) {
    return stringOrEmpty(node?.value);
  }

  function stringOrEmpty(value) {
    return typeof value === "string" ? value : "";
  }

  return {
    parse
  };
})();
