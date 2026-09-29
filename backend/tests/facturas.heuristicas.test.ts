import { describe, it, expect } from "@jest/globals";
import { pareceFacturaConImportes, tieneRegistroMercantil } from "../src/services/extraccion.service";
import {
  aplicarSignoAbono,
  conciliarImportes,
  corregirFechaConTexto,
  normalizarFecha,
  normalizarMoneda,
  normalizarNif,
  reconciliarPartes,
  resolverDireccion,
  verificarImportesReales,
  type DatosFactura,
} from "../src/services/facturas.service";
import type { Empresa } from "../src/entities/Empresa";

// Tests PUROS de las heurísticas deterministas de facturas (venta/compra, emisor/
// cliente, idioma). No tocan BD ni Ollama. Blindan la lógica frágil (regex, anclas)
// contra regresiones, usando casos reales (TRAZA, Repsol catalán, DonDominio→ATEKA).

// Empresa mínima (resolverDireccion solo lee nombre y nif).
const emp = (nombre: string, nif: string | null = null): Empresa =>
  ({ nombre, nif }) as unknown as Empresa;

describe("tieneRegistroMercantil", () => {
  it("detecta la línea legal en castellano, catalán y gallego", () => {
    expect(tieneRegistroMercantil("… Inscrita en el Registro Mercantil de Madrid")).toBe(true);
    expect(tieneRegistroMercantil("… Inscrita en el Registre Mercantil de Cantàbria")).toBe(true);
    expect(tieneRegistroMercantil("… Rexistro Mercantil de A Coruña")).toBe(true);
  });
  it("no dispara con texto sin esa línea", () => {
    expect(tieneRegistroMercantil("Factura 123 total 50,00 €")).toBe(false);
  });
});

describe("pareceFacturaConImportes", () => {
  it("acepta importes monetarios reales", () => {
    expect(pareceFacturaConImportes("Total a pagar 120,00 €")).toBe(true);
    expect(pareceFacturaConImportes("importe 1.234,56")).toBe(true);
    expect(pareceFacturaConImportes("Subtotal $ 50.00")).toBe(true);
  });
  it("acepta términos de factura en catalán e inglés", () => {
    expect(pareceFacturaConImportes("This is an invoice for services")).toBe(true);
    expect(pareceFacturaConImportes("VAT 21%")).toBe(true);
    expect(pareceFacturaConImportes("Base imposable de la factura")).toBe(true);
    expect(pareceFacturaConImportes("un rebut de la llum")).toBe(true);
  });
  it("rechaza texto que no es factura", () => {
    expect(pareceFacturaConImportes("una foto de un gato en el jardín")).toBe(false);
    expect(pareceFacturaConImportes("cantidad total precio referencia")).toBe(false);
  });
});

describe("reconciliarPartes", () => {
  const REPSOL =
    "Factura de llum\nAKX STUDIO SL\n…\nRepsol Comercializadora de Electricidad y Gas, S.L.U. " +
    "Inscrita en el Registre Mercantil de Cantàbria (T. 1007) NIF B39540760";

  it("invierte emisor↔cliente cuando el cliente coincide con la línea de registro (TRAZA)", () => {
    const d: DatosFactura = {
      emisor: "AKX STUDIO SL",
      emisorNif: "B13861935",
      cliente: "TRAZA NOSITEC S.L.U.",
      clienteNif: "B61462735",
    };
    const contenido =
      "AKX STUDIO SL\nA/A XAVIER\n…\nTRAZA NOSITEC S.L.U. Inscrita en el Registro Mercantil de Barcelona NIF B61462735";
    reconciliarPartes(d, contenido);
    expect(d.emisor).toBe("TRAZA NOSITEC S.L.U.");
    expect(d.cliente).toBe("AKX STUDIO SL");
    expect(d.emisorNif).toBe("B61462735");
    expect(d.clienteNif).toBe("B13861935");
  });

  it("fija el emisor por el pie legal cuando emisor==cliente (Repsol)", () => {
    const d: DatosFactura = { emisor: "AKX STUDIO SL", cliente: "AKX STUDIO SL", emisorNif: "B13861935" };
    reconciliarPartes(d, REPSOL);
    expect(d.emisor).toBe("Repsol Comercializadora de Electricidad y Gas, S.L.U.");
    expect(d.emisorNif).toBe("B39540760");
  });

  it("tolera ruido OCR en el nombre del cliente (AKX vs ARX)", () => {
    const d: DatosFactura = { emisor: "AKX STUDIO SL", cliente: "ARX STUDIO SL" };
    reconciliarPartes(d, REPSOL);
    expect(d.emisor).toBe("Repsol Comercializadora de Electricidad y Gas, S.L.U.");
  });

  it("no toca una extracción ya correcta (emisor = empresa del registro)", () => {
    const d: DatosFactura = { emisor: "Tesys Internet S.L.U.", cliente: "AKX Studio SLU" };
    reconciliarPartes(
      d,
      "Tesys Internet S.L.U. … Sociedad inscrita en el Registro Mercantil de La Rioja",
    );
    expect(d.emisor).toBe("Tesys Internet S.L.U.");
    expect(d.cliente).toBe("AKX Studio SLU");
  });

  it("no hace nada sin línea de registro (factura extranjera)", () => {
    const d: DatosFactura = { emisor: "iFastNet", cliente: "AKX Studio" };
    reconciliarPartes(d, "iFastNet invoice total 18.14 USD");
    expect(d.emisor).toBe("iFastNet");
  });
});

describe("resolverDireccion", () => {
  const AKX = emp("AKX Studio SLU", "B13861935");

  it("clasifica por CIF: cliente = empresa → compra", () => {
    const d: DatosFactura = { emisor: "Tesys", emisorNif: "B26309096", cliente: "AKX", clienteNif: "B13861935" };
    expect(resolverDireccion(d, AKX)).toBe("compra");
  });

  it("clasifica por CIF: emisor = empresa → venta", () => {
    const d: DatosFactura = { emisor: "AKX", emisorNif: "B13861935", cliente: "Cliente X", clienteNif: "B99999999" };
    expect(resolverDireccion(d, AKX)).toBe("venta");
  });

  it("#4: el CIF de la empresa aparece en el texto y el emisor es otro → compra", () => {
    const d: DatosFactura = { emisor: "Repsol", emisorNif: "B39540760", cliente: "ARX STUDIO", clienteNif: "" };
    const contenido = "Factura de llum … client AKX … NIF B13861935 …";
    expect(resolverDireccion(d, AKX, contenido)).toBe("compra");
  });

  it("clasifica por nombre cuando no hay CIF guardado", () => {
    const sinCif = emp("AKX Studio SLU", null);
    const d: DatosFactura = { emisor: "Tesys Internet SLU", cliente: "AKX Studio SLU" };
    expect(resolverDireccion(d, sinCif)).toBe("compra");
  });

  it("emisor == cliente (degenerado) → desconocido", () => {
    const d: DatosFactura = { emisor: "AKX Studio", cliente: "AKX Studio", emisorNif: "B13861935" };
    expect(resolverDireccion(d, AKX)).toBe("desconocido");
  });

  it("ninguna parte es la empresa → desconocido", () => {
    const d: DatosFactura = { emisor: "Foo SL", cliente: "Bar SL" };
    expect(resolverDireccion(d, AKX)).toBe("desconocido");
  });
});

describe("corregirFechaConTexto (día/mes intercambiados)", () => {
  const hoy = new Date("2026-09-28T10:00:00Z");

  it("10/09/2026 leído a la americana (2026-10-09, futuro) → 2026-09-10", () => {
    expect(corregirFechaConTexto("2026-10-09", "Fecha factura: 10/09/2026", hoy)).toBe("2026-09-10");
  });

  it("fecha bien leída → no se toca", () => {
    expect(corregirFechaConTexto("2026-09-10", "Fecha factura: 10/09/2026", hoy)).toBe("2026-09-10");
  });

  it("factura americana bien leída (pasada) → no se invierte", () => {
    // 09/10/2026 en EE. UU. = 10 de septiembre; ya pasó, así que se respeta.
    expect(corregirFechaConTexto("2026-09-10", "Invoice date: 09/10/2026", hoy)).toBe("2026-09-10");
  });

  it("factura americana leída a la española (09/10/2026 → 2026-10-09, futuro) → 2026-09-10", () => {
    expect(corregirFechaConTexto("2026-10-09", "Invoice date: 09/10/2026", hoy)).toBe("2026-09-10");
  });

  it("fecha futura sin la invertida en el texto → no se inventa", () => {
    expect(corregirFechaConTexto("2026-10-09", "Vencimiento: 9 de octubre de 2026", hoy)).toBe("2026-10-09");
  });

  it("día > 12 (no se puede invertir) o día = mes → sin cambios", () => {
    expect(corregirFechaConTexto("2026-10-25", "25/10/2026", hoy)).toBe("2026-10-25");
    expect(corregirFechaConTexto("2026-10-10", "10/10/2026", hoy)).toBe("2026-10-10");
  });

  it("sin fecha → null", () => {
    expect(corregirFechaConTexto(null, "10/09/2026", hoy)).toBeNull();
  });
});

describe("abonos y descuentos (importes negativos)", () => {
  it("un abono conserva sus importes negativos si están en el texto", () => {
    const d: DatosFactura = {
      subtotal: -41.32,
      iva: -8.68,
      total: -50,
      lineas: [{ descripcion: "Devolución", cantidad: 1, precioUnit: -41.32, total: -41.32 }],
    };
    verificarImportesReales(d, "FACTURA RECTIFICATIVA Base -41,32 € IVA 21% -8,68 € Total -50,00 €");
    expect(d.total).toBe(-50);
    expect(d.lineas![0].total).toBe(-41.32);
  });

  it("un importe que no está en el texto se sigue vaciando", () => {
    const d: DatosFactura = { total: 999 };
    verificarImportesReales(d, "Total 50,00 €");
    expect(d.total).toBe(0);
  });

  it("conciliar completa el total negativo de un abono", () => {
    const d: DatosFactura = { subtotal: -41.32, iva: -8.68, lineas: [] };
    conciliarImportes(d);
    expect(d.total).toBe(-50);
  });

  it("una línea de descuento negativa cuenta en el subtotal", () => {
    const d: DatosFactura = {
      iva: 18.9,
      lineas: [
        { descripcion: "Servicio", cantidad: 1, precioUnit: 100 },
        { descripcion: "Descuento", cantidad: 1, total: -10 },
      ],
    };
    conciliarImportes(d);
    expect(d.subtotal).toBe(90);
    expect(d.total).toBe(108.9);
  });
});

describe("aplicarSignoAbono (devolución con importes en positivo)", () => {
  const abono = (): DatosFactura => ({
    abono: true,
    subtotal: 100,
    iva: 21,
    total: 121,
    lineas: [
      { descripcion: "Producto devuelto", cantidad: 1, precioUnit: 110, total: 110 },
      { descripcion: "Descuento", cantidad: 1, precioUnit: -10, total: -10 },
    ],
  });

  it("marca de la IA + palabra en el texto → invierte todo el documento", () => {
    const d = abono();
    aplicarSignoAbono(d, "FACTURA RECTIFICATIVA R-2026/3 … Total 121,00 €");
    expect([d.subtotal, d.iva, d.total]).toEqual([-100, -21, -121]);
    expect(d.lineas?.map((l) => l.total)).toEqual([-110, 10]);
    expect(d.lineas?.[0].cantidad).toBe(1);
  });

  it("reconoce devolución en catalán y credit note en inglés", () => {
    const cat = abono();
    aplicarSignoAbono(cat, "Factura de devolució núm. 12");
    expect(cat.total).toBe(-121);
    const en = abono();
    aplicarSignoAbono(en, "CREDIT NOTE #CN-004");
    expect(en.total).toBe(-121);
  });

  it("sin palabra de abono en el texto no toca nada (la IA pudo equivocarse)", () => {
    const d = abono();
    aplicarSignoAbono(d, "Factura 2026/15 … Total 121,00 €");
    expect(d.total).toBe(121);
  });

  it("sin la marca de la IA no toca nada aunque el texto hable de devoluciones", () => {
    const d = { ...abono(), abono: false };
    aplicarSignoAbono(d, "Factura 2026/15. Plazo de devolución: 30 días.");
    expect(d.total).toBe(121);
  });

  it("si el total ya es negativo no lo vuelve a invertir", () => {
    const d: DatosFactura = { abono: true, subtotal: -100, iva: -21, total: -121 };
    aplicarSignoAbono(d, "Abono A-7");
    expect(d.total).toBe(-121);
  });

  it("una devolución sin cargo (importes a 0) se queda en 0", () => {
    const d: DatosFactura = { abono: true, total: 0, lineas: [] };
    aplicarSignoAbono(d, "Factura de devolución RMA 2.025/SAT/542");
    expect(d.total).toBe(0);
  });
});

describe("normalizarNif (prefijo ES, CIF/NIE con letra final)", () => {
  it("quita el prefijo VAT ES", () => {
    expect(normalizarNif("ESB13861935")).toBe("B13861935");
    expect(normalizarNif("ES B-13861935")).toBe("B13861935");
    expect(normalizarNif("ESQ2826000H")).toBe("Q2826000H");
  });

  it("deja igual DNI, NIE y CIF sin prefijo", () => {
    expect(normalizarNif("b13861935")).toBe("B13861935");
    expect(normalizarNif("X1234567L")).toBe("X1234567L");
    expect(normalizarNif("12345678Z")).toBe("12345678Z");
  });

  it("clasifica como compra aunque el CIF venga con ES en la factura", () => {
    const empresa = { nombre: "AKX Studio SL", nif: "B13861935" } as Empresa;
    expect(
      resolverDireccion(
        { emisor: "Repsol", emisorNif: "A12345678", cliente: "AKX", clienteNif: "ESB13861935" },
        empresa,
      ),
    ).toBe("compra");
    expect(
      resolverDireccion({ emisor: "Repsol", emisorNif: "A12345678" }, empresa, "Cliente NIF: ESB13861935"),
    ).toBe("compra");
  });
});

describe("normalizarMoneda", () => {
  it("no acepta como divisa 3 letras que no lo son", () => {
    expect(normalizarMoneda("IVA")).toBe("EUR");
    expect(normalizarMoneda("TAX")).toBe("EUR");
  });

  it("reconoce nombres en inglés y códigos ISO reales", () => {
    expect(normalizarMoneda("dollars")).toBe("USD");
    expect(normalizarMoneda("US  Dollars")).toBe("USD");
    expect(normalizarMoneda("Pounds")).toBe("GBP");
    expect(normalizarMoneda("cad")).toBe("CAD");
    expect(normalizarMoneda("SEK")).toBe("SEK");
  });
});

describe("normalizarFecha", () => {
  it("admite los formatos que devuelve el modelo", () => {
    expect(normalizarFecha("2026-9-10")).toBe("2026-09-10");
    expect(normalizarFecha("2026/09/10")).toBe("2026-09-10");
    expect(normalizarFecha("2026-09-10T00:00:00Z")).toBe("2026-09-10");
    expect(normalizarFecha("10/09/2026")).toBe("2026-09-10");
  });

  it("rechaza fechas imposibles o vacías", () => {
    expect(normalizarFecha("2026-02-30")).toBeNull();
    expect(normalizarFecha("")).toBeNull();
  });
});
