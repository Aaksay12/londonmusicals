-- London Musicals Database Schema

CREATE TABLE IF NOT EXISTS musicals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  venue_name TEXT NOT NULL,
  venue_address TEXT,
  type TEXT NOT NULL CHECK (type IN ('West End', 'Off West End', 'Drama School')),
  start_date DATE NOT NULL,
  end_date DATE,
  description TEXT,
  ticket_url TEXT,
  image_url TEXT,
  price_from REAL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Index for filtering by date range
CREATE INDEX IF NOT EXISTS idx_musicals_dates ON musicals(start_date, end_date);

-- Index for filtering by type
CREATE INDEX IF NOT EXISTS idx_musicals_type ON musicals(type);

-- Insert sample data
INSERT INTO musicals (title, venue_name, venue_address, type, start_date, end_date, description, ticket_url, price_from) VALUES
('Wicked', 'Apollo Victoria Theatre', 'Wilton Road, London SW1V 1LG', 'West End', '2006-09-27', '2025-12-31', 'The untold story of the Witches of Oz', 'https://wickedthemusical.co.uk', 29.50),
('The Lion King', 'Lyceum Theatre', '21 Wellington St, London WC2E 7RQ', 'West End', '1999-10-19', '2025-12-31', 'Disney''s award-winning musical', 'https://thelionking.co.uk', 35.00),
('Les Miserables', 'Sondheim Theatre', '51 Shaftesbury Ave, London W1D 6BA', 'West End', '2004-09-01', '2025-12-31', 'The world''s longest running musical', 'https://lesmis.com', 25.00),
('Hamilton', 'Victoria Palace Theatre', 'Victoria St, London SW1E 5EA', 'West End', '2017-12-06', '2025-12-31', 'The story of America''s Founding Father', 'https://hamiltonmusical.com/london', 39.00),
('Matilda The Musical', 'Cambridge Theatre', 'Earlham St, London WC2H 9HU', 'West End', '2011-11-24', '2025-12-31', 'Roald Dahl''s beloved story', 'https://matildathemusical.com', 24.00),
('Hadestown', 'Lyric Theatre', '29 Shaftesbury Ave, London W1D 7ES', 'West End', '2024-02-01', '2025-06-30', 'A folk opera journey to the underworld', 'https://hadestown.co.uk', 25.00),
('Sunset Boulevard', 'St James Theatre', '116 Victoria St, London SW1E 5LB', 'West End', '2024-09-01', '2025-03-31', 'Andrew Lloyd Webber revival', 'https://sunsetboulevardmusical.com', 35.00),
('Cabaret', 'Kit Kat Club at the Playhouse', 'Northumberland Ave, London WC2N 5DE', 'West End', '2021-11-15', '2025-12-31', 'Willkommen to the Kit Kat Club', 'https://kitkat.club', 45.00),
('Spring Awakening', 'Southwark Playhouse', '77-85 Newington Causeway, London SE1 6BD', 'Off West End', '2025-01-15', '2025-03-15', 'Rock musical about teenage discovery', 'https://southwarkplayhouse.co.uk', 18.00),
('Into The Woods', 'Theatre Royal Stratford East', 'Gerry Raffles Square, London E15 1BN', 'Off West End', '2025-02-01', '2025-04-01', 'Sondheim fairy tale mashup', 'https://stratfordeast.com', 15.00),
('Grease', 'LAMDA', '155 Talgarth Rd, London W14 9DA', 'Drama School', '2025-01-20', '2025-01-25', 'Student production of the classic', 'https://lamda.ac.uk', 12.00),
('Sweeney Todd', 'Royal Central School', '62-64 Eton Ave, London NW3 3HY', 'Drama School', '2025-02-10', '2025-02-15', 'Sondheim''s dark musical thriller', 'https://cssd.ac.uk', 10.00),
('Rent', 'Mountview Academy', 'Ralph Richardson Memorial Studios, London N22 6XF', 'Drama School', '2025-03-01', '2025-03-08', 'The Pulitzer-winning rock musical', 'https://mountview.org.uk', 12.00);
