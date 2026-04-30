// Admin GraphQL fetch for the rich detail we need on the order page:
// line items with custom attributes (artwork URLs), variants, images;
// customer with addresses and phone.

export interface AdminOrderDetail {
  note: string | null;
  customer: {
    firstName: string | null;
    lastName: string | null;
    email: string | null;
    phone: string | null;
    numberOfOrders?: string | null;
  } | null;
  shippingAddress: AdminAddress | null;
  billingAddress: AdminAddress | null;
  lineItems: AdminLineItem[];
}

export interface AdminAddress {
  name: string | null;
  address1: string | null;
  address2: string | null;
  city: string | null;
  province: string | null;
  zip: string | null;
  country: string | null;
  phone: string | null;
}

export interface AdminLineItem {
  id: string;
  title: string;
  quantity: number;
  variantTitle: string | null;
  variantImageUrl: string | null;
  productImageUrl: string | null;
  customAttributes: Array<{ key: string; value: string }>;
  artworkUrl: string | null;
  visibleProperties: Array<{ key: string; value: string }>;
}

const QUERY = `#graphql
  query OrderDetail($id: ID!) {
    order(id: $id) {
      note
      customer {
        firstName
        lastName
        email
        phone
        numberOfOrders
      }
      shippingAddress {
        name
        address1
        address2
        city
        province
        zip
        country
        phone
      }
      billingAddress {
        name
        address1
        address2
        city
        province
        zip
        country
        phone
      }
      lineItems(first: 50) {
        edges {
          node {
            id
            title
            quantity
            variantTitle
            variant {
              image { url }
            }
            image { url }
            customAttributes {
              key
              value
            }
          }
        }
      }
    }
  }
`;

const ARTWORK_KEY_HINTS = [
  "artwork",
  "logo",
  "uploaded",
  "design",
  "_artwork_url",
  "_logo",
  "art",
  "file",
];

function pickArtworkUrl(
  attrs: Array<{ key: string; value: string }>,
): string | null {
  // First: prefer a key that mentions artwork/logo/design
  for (const a of attrs) {
    const k = a.key.toLowerCase();
    if (
      ARTWORK_KEY_HINTS.some((h) => k.includes(h)) &&
      /^https?:\/\//.test(a.value)
    ) {
      return a.value;
    }
  }
  // Fallback: any value that looks like an image URL
  for (const a of attrs) {
    if (/^https?:\/\/.+\.(png|jpe?g|gif|webp|svg|tiff?|bmp)(\?|$)/i.test(a.value)) {
      return a.value;
    }
  }
  return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AdminLike = { graphql: (q: string, opts?: any) => Promise<Response> };

export async function fetchOrderDetail(
  admin: AdminLike,
  shopifyNumericOrderId: string,
): Promise<AdminOrderDetail | null> {
  const gid = `gid://shopify/Order/${shopifyNumericOrderId}`;
  const response = await admin.graphql(QUERY, { variables: { id: gid } });
  const json = (await response.json()) as {
    data?: {
      order: {
        note: string | null;
        customer: AdminOrderDetail["customer"];
        shippingAddress: AdminAddress | null;
        billingAddress: AdminAddress | null;
        lineItems: {
          edges: Array<{
            node: {
              id: string;
              title: string;
              quantity: number;
              variantTitle: string | null;
              variant: { image: { url: string } | null } | null;
              image: { url: string } | null;
              customAttributes: Array<{ key: string; value: string }>;
            };
          }>;
        };
      } | null;
    };
  };

  const order = json.data?.order;
  if (!order) return null;

  return {
    note: order.note,
    customer: order.customer,
    shippingAddress: order.shippingAddress,
    billingAddress: order.billingAddress,
    lineItems: order.lineItems.edges.map((e) => {
      const attrs = e.node.customAttributes ?? [];
      const visible = attrs.filter((a) => !a.key.startsWith("_"));
      return {
        id: e.node.id,
        title: e.node.title,
        quantity: e.node.quantity,
        variantTitle: e.node.variantTitle,
        variantImageUrl: e.node.variant?.image?.url ?? null,
        productImageUrl: e.node.image?.url ?? null,
        customAttributes: attrs,
        artworkUrl: pickArtworkUrl(attrs),
        visibleProperties: visible,
      };
    }),
  };
}
