import Image from "next/image";
import bannerImage from "../../public/static/assets/images/main-banner.jpeg";

const Banner = () => {
  return (
    <div style={{ position: "relative", width: "100%" }}>
      <Image
        src={bannerImage}
        alt="Banner"
        width={1125}
        height={720}
        layout="responsive"
        objectFit="cover"
      />
      <div
        style={{
          position: "absolute",
          top: "40%",
          left: "50%",
          transform: "translate(-50%, -200%)",
          textAlign: "center",
          color: "black",
          fontSize: "76px",
          fontWeight: "800",
          lineHeight: "76px",
          fontFamily: "__geistSansFont_8289af, arial",
          width: "60%",
        }}
      >
        The One Stop Platform for all your queries
      </div>
      <div
        style={{
          position: "absolute",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -800%)",
          textAlign: "center",
          color: "rgb(43, 43, 43)",
          fontSize: "24px",
          fontWeight: "600",
          lineHeight: "32px",
          fontFamily: "__geistSansFont_8289af, arial",
          width: "60%",
        }}
      >
        Get the best advice from our experts. From career to relationships, we
        have got you covered.
      </div>
      <div
        style={{
          position: "absolute",
          top: "60%",
          left: "50%",
          transform: "translate(-50%, -1200%)",
        }}
      >
        <a
          href="/link-to-page"
          className="bg-gradient-to-r from-black to-slate-700 px-6 py-3 text-white rounded-full"
        >
          Look for Experts -&gt;
        </a>
      </div>
    </div>
  );
};

export default Banner;
