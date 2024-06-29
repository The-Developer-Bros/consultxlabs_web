import { useEffect, useState } from "react";
import axios from "axios";
import Image from "next/image";
import Slider from "react-slick";
import "slick-carousel/slick/slick-theme.css";

// Define an interface for the user data
interface User {
  id: number;
  Name: string;
  "Review Rating": number;
  "Number of Reviews": number;
  "Consultant Category": string;
}

const UserCarousel = () => {
  const [users, setUsers] = useState<User[]>([]); // Use the User interface here

  useEffect(() => {
    axios
      .get("https://retoolapi.dev/f0fmcj/data")
      .then((response) => {
        setUsers(response.data);
      })
      .catch((error) => {
        console.error("Error fetching data: ", error);
      });
  }, []);

  let settings = {
    dots: true,
    infinite: true,
    speed: 500,
    slidesToShow: 1,
    slidesToScroll: 1,
  };

  return (
    <Slider {...settings}>
      {users.map((user) => (
        <div
          key={user.id}
          style={{
            borderRadius: "10px",
            width: "30px",
            height: "30px",
            position: "relative",
          }}
        >
          {/* Replace with your actual image */}
          <Image
            src="/path-to-your-image.jpg"
            alt={user.Name}
            layout="fill"
            objectFit="cover"
          />{" "}
          {/* Use next/image's Image component here */}
          <p>{user.Name}</p>
          <p>{user["Consultant Category"]}</p>
          <div>
            {/* Replace with your actual star rating component */}
            {/* The star rating component should take the user's review rating as a prop */}
            {/* <StarRating rating={user['Review Rating']} /> */}
            <p>{user["Number of Reviews"]} reviews</p>
          </div>
        </div>
      ))}
    </Slider>
  );
};

export default UserCarousel;
