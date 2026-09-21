"use client";

import Link from "next/link";
import { ArrowRight, Cloud, Server } from "lucide-react";
import { useLocale } from "@/components/i18n/LocaleProvider";
import type { Locale } from "@/lib/i18n";
import styles from "./pricing.module.css";

type OfferCopy = {
  label: string;
  name: string;
  price: string;
  cadence: string;
  description: string;
  compute: string;
  cta: string;
};

type PricingCopy = {
  eyebrow: string;
  title: string;
  emphasis: string;
  intro: string;
  platform: string;
  compute: string;
  free: string;
  footnote: string;
  own: OfferCopy;
  hosted: OfferCopy;
};

// Public pricing describes the platform and capacity separately. The older
// subscription tiers in MARKETING_COPY belong to the legacy agent-plan flow.
// Keep every locale on this offer; do not fall back to those commercial terms.
const PRICING_COPY: Record<Locale, PricingCopy> = {
  en: {
    eyebrow: "Pricing", title: "The platform is free.", emphasis: "Choose where it runs.",
    intro: "Use your own server or cloud account. Add paid Hivra Cloud capacity whenever you want us to run the machines.",
    platform: "Platform", compute: "Compute", free: "Free",
    footnote: "Your own infrastructure and model provider's charges are separate. Adding Hivra Cloud capacity is optional.",
    own: { label: "Your infrastructure", name: "Free platform", price: "$0", cadence: "platform fee", description: "Connect the server or cloud account you already use. Run your agents and computers there.", compute: "Your server or cloud", cta: "Connect your server or cloud" },
    hosted: { label: "Managed by Hivra", name: "Hivra Cloud", price: "Paid", cadence: "compute", description: "Add hosted capacity when you want us handling the machines. The platform is still free.", compute: "Billed separately", cta: "View hosted options" },
  },
  "zh-CN": {
    eyebrow: "价格", title: "平台免费。", emphasis: "运行在哪里，由你决定。",
    intro: "使用你自己的服务器或云账户。想让我们管理机器时，可以另购 Hivra Cloud 算力。",
    platform: "平台", compute: "算力", free: "免费",
    footnote: "你自己的基础设施和模型服务费用另计。是否购买 Hivra Cloud 算力，由你决定。",
    own: { label: "你的基础设施", name: "免费平台", price: "$0", cadence: "平台费用", description: "连接你已有的服务器或云账户，在那里运行智能体和电脑。", compute: "你的服务器或云", cta: "连接服务器或云账户" },
    hosted: { label: "由 Hivra 管理", name: "Hivra Cloud", price: "付费", cadence: "算力", description: "想让我们管理机器时，可以购买托管算力。平台仍然免费。", compute: "单独计费", cta: "查看托管选项" },
  },
  es: {
    eyebrow: "Precios", title: "La plataforma es gratis.", emphasis: "Tú eliges dónde funciona.",
    intro: "Usa tu propio servidor o cuenta de nube. Añade capacidad de pago en Hivra Cloud cuando quieras que nos encarguemos de las máquinas.",
    platform: "Plataforma", compute: "Cómputo", free: "Gratis",
    footnote: "Tu infraestructura y el uso de tu proveedor de modelos se pagan por separado. Añadir capacidad de Hivra Cloud es opcional.",
    own: { label: "Tu infraestructura", name: "Plataforma gratis", price: "$0", cadence: "por la plataforma", description: "Conecta el servidor o la cuenta de nube que ya usas. Ejecuta allí tus agentes y ordenadores.", compute: "Tu servidor o nube", cta: "Conecta tu servidor o nube" },
    hosted: { label: "Gestionado por Hivra", name: "Hivra Cloud", price: "De pago", cadence: "cómputo", description: "Añade capacidad alojada cuando quieras que gestionemos las máquinas. La plataforma sigue siendo gratis.", compute: "Se factura por separado", cta: "Ver opciones de alojamiento" },
  },
  "pt-BR": {
    eyebrow: "Preços", title: "A plataforma é grátis.", emphasis: "Você escolhe onde rodar.",
    intro: "Use seu próprio servidor ou conta de nuvem. Adicione capacidade paga no Hivra Cloud quando quiser deixar as máquinas com a gente.",
    platform: "Plataforma", compute: "Computação", free: "Grátis",
    footnote: "Sua infraestrutura e o uso do provedor de modelos são pagos separadamente. Adicionar capacidade do Hivra Cloud é opcional.",
    own: { label: "Sua infraestrutura", name: "Plataforma grátis", price: "$0", cadence: "pela plataforma", description: "Conecte o servidor ou a conta de nuvem que você já usa. Rode seus agentes e computadores lá.", compute: "Seu servidor ou nuvem", cta: "Conectar seu servidor ou nuvem" },
    hosted: { label: "Gerenciado pelo Hivra", name: "Hivra Cloud", price: "Pago", cadence: "computação", description: "Adicione capacidade hospedada quando quiser que a gente cuide das máquinas. A plataforma continua grátis.", compute: "Cobrado separadamente", cta: "Ver opções de hospedagem" },
  },
  fr: {
    eyebrow: "Tarifs", title: "La plateforme est gratuite.", emphasis: "Choisissez où elle tourne.",
    intro: "Utilisez votre serveur ou compte cloud. Ajoutez de la capacité payante sur Hivra Cloud quand vous voulez nous confier les machines.",
    platform: "Plateforme", compute: "Calcul", free: "Gratuit",
    footnote: "Votre infrastructure et votre fournisseur de modèles sont facturés séparément. Ajouter de la capacité Hivra Cloud est facultatif.",
    own: { label: "Votre infrastructure", name: "Plateforme gratuite", price: "$0", cadence: "pour la plateforme", description: "Connectez le serveur ou compte cloud que vous utilisez déjà. Faites-y tourner vos agents et ordinateurs.", compute: "Votre serveur ou cloud", cta: "Connecter votre serveur ou cloud" },
    hosted: { label: "Géré par Hivra", name: "Hivra Cloud", price: "Payant", cadence: "calcul", description: "Ajoutez de la capacité hébergée quand vous voulez nous confier les machines. La plateforme reste gratuite.", compute: "Facturé séparément", cta: "Voir les options d’hébergement" },
  },
  de: {
    eyebrow: "Preise", title: "Die Plattform ist kostenlos.", emphasis: "Du wählst, wo sie läuft.",
    intro: "Nutze deinen eigenen Server oder Cloud-Account. Buche kostenpflichtige Kapazität in Hivra Cloud dazu, wenn wir die Maschinen betreiben sollen.",
    platform: "Plattform", compute: "Rechenleistung", free: "Kostenlos",
    footnote: "Deine Infrastruktur und dein Modellanbieter werden separat bezahlt. Kapazität in Hivra Cloud ist optional.",
    own: { label: "Deine Infrastruktur", name: "Kostenlose Plattform", price: "$0", cadence: "Plattformgebühr", description: "Verbinde deinen vorhandenen Server oder Cloud-Account. Lass deine Agenten und Computer dort laufen.", compute: "Dein Server oder Cloud-Account", cta: "Server oder Cloud verbinden" },
    hosted: { label: "Von Hivra verwaltet", name: "Hivra Cloud", price: "Bezahlt", cadence: "Rechenleistung", description: "Buche gehostete Kapazität dazu, wenn wir die Maschinen betreiben sollen. Die Plattform bleibt kostenlos.", compute: "Separat abgerechnet", cta: "Hosting-Optionen ansehen" },
  },
  ja: {
    eyebrow: "料金", title: "プラットフォームは無料。", emphasis: "動かす場所はあなたが選ぶ。",
    intro: "自分のサーバーやクラウドアカウントを利用できます。マシンの運用を任せたいときは、有料の Hivra Cloud を追加できます。",
    platform: "プラットフォーム", compute: "コンピューティング", free: "無料",
    footnote: "自分のインフラとモデルプロバイダーの利用料金は別途かかります。Hivra Cloud の追加は任意です。",
    own: { label: "自分のインフラ", name: "無料プラットフォーム", price: "$0", cadence: "プラットフォーム料金", description: "すでに使っているサーバーやクラウドアカウントを接続し、そこでエージェントやコンピューターを動かせます。", compute: "自分のサーバーやクラウド", cta: "サーバーやクラウドを接続" },
    hosted: { label: "Hivra が管理", name: "Hivra Cloud", price: "有料", cadence: "コンピューティング", description: "マシンの運用を任せたいときに、ホスティングを追加。プラットフォームは引き続き無料です。", compute: "別途請求", cta: "ホスティングの選択肢を見る" },
  },
  ko: {
    eyebrow: "요금", title: "플랫폼은 무료입니다.", emphasis: "실행할 곳은 직접 선택하세요.",
    intro: "자신의 서버나 클라우드 계정을 사용하세요. 머신 운영을 맡기고 싶을 때 유료 Hivra Cloud 용량을 추가할 수 있습니다.",
    platform: "플랫폼", compute: "컴퓨팅", free: "무료",
    footnote: "자체 인프라와 모델 제공업체의 이용 요금은 별도입니다. Hivra Cloud 용량 추가는 선택 사항입니다.",
    own: { label: "자신의 인프라", name: "무료 플랫폼", price: "$0", cadence: "플랫폼 요금", description: "이미 사용하는 서버나 클라우드 계정을 연결하고, 그곳에서 에이전트와 컴퓨터를 실행하세요.", compute: "자신의 서버 또는 클라우드", cta: "서버 또는 클라우드 연결" },
    hosted: { label: "Hivra가 관리", name: "Hivra Cloud", price: "유료", cadence: "컴퓨팅", description: "머신 운영을 맡기고 싶을 때 호스팅 용량을 추가하세요. 플랫폼은 계속 무료입니다.", compute: "별도 청구", cta: "호스팅 옵션 보기" },
  },
};

export default function PricingSection() {
  const { locale } = useLocale();
  const copy = PRICING_COPY[locale];

  return (
    <section id="pricing" className={styles.pricing} aria-labelledby="pricing-heading">
      <header className={styles.heading}>
        <span className={styles.eyebrow}>{copy.eyebrow}</span>
        <h2 id="pricing-heading">{copy.title}<span>{copy.emphasis}</span></h2>
        <p>{copy.intro}</p>
      </header>

      {/* Both offers ship visibly in server HTML. No animation or observer gates them. */}
      <div className={styles.offers}>
        <PricingOffer kind="own" offer={copy.own} copy={copy} />
        <PricingOffer kind="hosted" offer={copy.hosted} copy={copy} />
      </div>
      <p className={styles.footnote}>{copy.footnote}</p>
    </section>
  );
}

function PricingOffer({ kind, offer, copy }: { kind: "own" | "hosted"; offer: OfferCopy; copy: PricingCopy }) {
  const headingId = `pricing-${kind}-heading`;
  const Icon = kind === "own" ? Server : Cloud;

  return (
    <article className={styles.offer} data-offer={kind} aria-labelledby={headingId}>
      <div className={styles.offerLabel}>
        <span><span aria-hidden="true">{kind === "own" ? "01" : "02"} / </span>{offer.label}</span>
        <Icon size={23} strokeWidth={1.5} aria-hidden="true" />
      </div>
      <h3 id={headingId}>{offer.name}</h3>
      <div className={styles.priceBlock}>
        <p className={styles.price}><strong>{offer.price}</strong><span>{offer.cadence}</span></p>
      </div>
      <p className={styles.description}>{offer.description}</p>
      <dl className={styles.costs}>
        <div><dt>{copy.platform}</dt><dd>{copy.free}</dd></div>
        <div><dt>{copy.compute}</dt><dd>{offer.compute}</dd></div>
      </dl>
      <Link href="/dashboard/infrastructure" id={`pricing-${kind}-cta`} className={styles.action}>
        <span>{offer.cta}</span><ArrowRight size={20} strokeWidth={1.5} aria-hidden="true" />
      </Link>
    </article>
  );
}
