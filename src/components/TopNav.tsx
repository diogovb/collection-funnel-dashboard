"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Navegação entre as telas do dashboard.
 *
 * Existe porque o Funil e os Experimentos respondem perguntas diferentes e têm
 * custos de carga muito diferentes — o funil baixa e agrega no navegador, o de
 * experimento vem pronto do banco. Rotas separadas mantêm cada um no seu ritmo,
 * e um erro no novo não derruba o que já funciona.
 */
const ABAS = [
  { href: "/", label: "Funil" },
  { href: "/origem", label: "Origem" },
  { href: "/experimentos", label: "Experimentos" },
  { href: "/retencao", label: "Retenção" },
];

export default function TopNav() {
  const pathname = usePathname();

  return (
    <nav className="max-w-5xl mx-auto px-3 sm:px-4 pt-4">
      <div className="flex gap-1.5">
        {ABAS.map((aba) => {
          const ativa =
            aba.href === "/" ? pathname === "/" : pathname.startsWith(aba.href);
          return (
            <Link
              key={aba.href}
              href={aba.href}
              className={
                ativa
                  ? "px-3 py-1.5 rounded-lg text-sm font-medium bg-gradient-to-r from-indigo-600 to-purple-600 text-white"
                  : "px-3 py-1.5 rounded-lg text-sm font-medium text-gray-400 hover:text-gray-200 hover:bg-gray-900/60"
              }
            >
              {aba.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
