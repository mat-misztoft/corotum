import { createElement } from "react";
import { createRoot } from "react-dom/client";
import SignInPage from "../app/sign-in/page";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(createElement(SignInPage));
