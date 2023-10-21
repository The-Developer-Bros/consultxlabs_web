import Image from "next/image";
import bannerImage from "src/assets/images/main-banner.jpeg";

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
          transform: "translate(-50%, -50%)",
          textAlign: "center",
          color: "black", 
          fontSize: "100px",
          width: "50%", 
        }}
      >
        Get Expert Advice from the Best Consultants
      </div>
      <div
        style={{
          position: "absolute",
          bottom: "200px",
          left: "50%",
          transform: "translateX(-100%)",
        }}
      >
        <input
          type="text"
          placeholder="Search Consultants, Area of expertise and Ongoing Webinars "
          style={{
            borderRadius: "10px",
            padding: "15px",
            width: "200%",
            margin: "auto",
            fontSize: "18px",
            background: "lightgray",
            color: "black",
          }}
        />
      </div>
    </div>
  );
};

export default Banner;
