# Security Features Summary

This document lists the security features currently in place for this application. It is meant to be a plain language summary, not a technical deep dive. It covers login and access control, network protection, data protection, application safety, and ongoing monitoring.

## 1. Login and Access Control

**Single sign-on with Authentik**
Users must log in through Authentik before they can reach the dashboard or the Node-RED editor. There is no separate login system to manage or forget about.

**Every request is checked, not just the login page**
The system checks each request as it comes in, not only at the moment of login. If someone tries to skip the login step and reach a page directly, they get blocked.

**Group based permissions**
Certain actions, like reviewing and confirming fault events, are limited to users in a specific reviewer group. Being logged in is not enough on its own to do everything. A user also needs to belong to the right group.

**Internal secret to prevent spoofing**
Internal services pass identity information to each other using headers. A shared secret is used to confirm those headers actually came from a trusted source and were not faked by another program on the network.

## 2. Network Protection

**Encrypted connections (HTTPS)**
All traffic to the dashboard is encrypted using TLS. Plain unencrypted HTTP requests are automatically redirected to the secure version.

**Security headers on every page**
The browser is told to block certain risky behaviors by default, including loading content from unexpected sources, being displayed inside another site's frame, and guessing file types incorrectly.

**Rate limiting**
Both the login page and the main dashboard have limits on how many requests can come from one source in a short time. This helps prevent flooding attacks and automated password guessing.

**No direct access to internal services**
The database, the backend server, and other internal pieces are not reachable from outside the system. Only the dashboard and Node-RED editor are exposed, and both require login.

**Limited internet access for internal services**
Internal services such as the database do not have general internet access. This means that if one of these services were ever compromised, it would be harder for an attacker to send stolen data out or download additional tools.

**Host level firewall (in progress)**
A firewall ruleset has been written for the server itself, in addition to the protections already running inside the application. This restricts which outside computers are even allowed to attempt a connection. This still needs to be turned on by someone with direct access to the physical server, so it is written but not yet active.

## 3. Data Protection

**Safe database queries**
All database queries use a method that keeps user input separate from the command itself. This prevents a common attack called SQL injection, where an attacker tries to sneak commands into a text field.

**Each database user only has access to what it needs**
The system uses several different database accounts instead of one all powerful account. Each account can only reach the specific data it is supposed to work with. For example, one account can only read training data and cannot make changes anywhere.

**Databases are separated from each other**
Database accounts are also blocked from connecting to databases they were never meant to use in the first place. This closes a default setting in the database software that would otherwise allow any account to at least attempt a connection to any database.

**Passwords and secrets are not stored in the code**
All passwords and secret keys are kept in a separate configuration file that is excluded from the code repository. They are never written directly into the application code.

**A written process for changing secrets**
If a password or secret key is ever exposed, there is now a step by step guide for changing it safely, without needing to rebuild the whole system from scratch.

## 4. Application Safety

**File upload checks**
When a file is uploaded, the system checks both its file extension and its declared file type before accepting it. Uploaded files are also saved under a randomly generated name, not the name the user provided. This prevents an attacker from using a tricky file name to overwrite or access other files on the server.

**Upload size limits**
There are limits on how large an uploaded file can be and how much data can be sent in a single request. This helps prevent the server from being overwhelmed.

**Export files are checked for hidden commands**
When data is exported to a spreadsheet file, any value that looks like it could be interpreted as a formula is safely marked as plain text. This prevents a hidden command from running if someone opens the file in a program like Excel.

**Error messages do not leak internal details**
When something goes wrong on the server, the user sees a general error message. Internal details like file paths or system errors are recorded in the server logs instead, where they are not visible to the public.

**Only expected data is accepted**
Incoming sensor data is checked against expected value ranges and formats before it is stored. Data that looks wrong or out of range is rejected instead of being saved.

## 5. Ongoing Monitoring and Maintenance

**Automatic dependency checks**
The software libraries this application depends on are checked once a day using an automated tool. If one of them is found to have a known security weakness, the check will fail and flag it, instead of it going unnoticed.

**Containers run with reduced permissions**
Each part of the application runs inside its own container. These containers are set up to run without extra system level permissions unless they are specifically required. This limits how much damage could be done if one part of the system were ever compromised.

**Containers run as regular users, not administrators**
The application processes run as normal, low privilege users inside their containers rather than as an administrator or root user. This is another layer that limits what an attacker could do if they managed to run code inside one of these containers.

## Summary

This application currently has protections in place across four main areas. Access is controlled through login and group permissions. The network is locked down so that only the necessary parts are reachable from outside. Data is separated by account and protected from common attacks. The application itself checks and limits what it accepts.

The one item still in progress is the host level firewall, which has been written but needs to be turned on by someone with direct physical or administrative access to the server. Everything else described in this document is already active.
