/**
 * This code was generated by v0 by Vercel.
 * @see https://v0.dev/t/viVw93zVdwn
 */
import {
  CardTitle,
  CardDescription,
  CardHeader,
  CardContent,
  CardFooter,
  Card,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  SelectValue,
  SelectTrigger,
  SelectLabel,
  SelectItem,
  SelectGroup,
  SelectContent,
  Select,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";

export default function UserOnboarding() {
  return (
    <div className="flex flex-col min-h-screen justify-center items-center bg-slate-950">
      <div className="mt-10 mb-10 bg-white shadow-md rounded-md">
        <Card className="max-w-2xl mx-auto">
          <CardHeader>
            <CardTitle>User Onboarding Form</CardTitle>
            <CardDescription>
              Enter user details to create a new user
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="first-name">First name</Label>
                  <Input id="first-name" placeholder="John" required />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="last-name">Last name</Label>
                  <Input id="last-name" placeholder="Doe" required />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  placeholder="johndoe@example.com"
                  required
                  type="email"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="phone-number">Phone Number</Label>
                <Input
                  id="phone-number"
                  pattern="[0-9]*"
                  required
                  type="text"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="role">Role</Label>
                <Select required={true}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select a role" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectLabel>Roles</SelectLabel>
                      <SelectItem value="consultee">Consultee</SelectItem>
                      <SelectItem value="consultant">Consultant</SelectItem>
                      <SelectItem value="staff">Staff</SelectItem>
                      <SelectItem value="admin">Admin</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </CardContent>
          <CardFooter className="flex justify-end">
            <Button
              className="w-full md:w-auto bg-black text-white hover:bg-gray-900
            "
              type="submit"
            >
              Next
            </Button>
          </CardFooter>
        </Card>
      </div>
    </div>
  );
}
